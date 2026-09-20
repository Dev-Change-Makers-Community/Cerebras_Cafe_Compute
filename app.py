"""Local proxy that streams GPT-4.1 (OpenAI) and GPT OSS 120B (Cerebras) side by side."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

ROOT = Path(__file__).parent
STATIC = ROOT / "static"

DEFAULT_PROMPT = (
    "Create a beginner-friendly study guide on Python functions. "
    "Include five key concepts with explanations, three runnable code examples, "
    "five practice exercises, and an answer key. Target approximately 800 words."
)

CEREBRAS_MODELS: dict[str, dict[str, str]] = {
    "gpt-oss-120b": {
        "label": "GPT OSS 120B · Cerebras API",
        "blurb": "gpt-oss-120b · advertised ~3,000 tok/s · Cerebras Chat Completions",
        "reasoning_effort": "low",
    },
    "qwen-3.8-27b": {
        "label": "Qwen 3.8 27B · Cerebras API",
        "blurb": "qwen-3.8-27b · reasoning off · Cerebras Chat Completions",
        "reasoning_effort": "none",
    },
}

PROVIDERS: dict[str, dict[str, Any]] = {
    "openai": {
        "label": "GPT-4.1 · OpenAI API",
        "model": "gpt-4.1",
        "url": "https://api.openai.com/v1/chat/completions",
        "env_key": "OPENAI_API_KEY",
    },
    "cerebras": {
        "label": "Cerebras API",
        "model": "gpt-oss-120b",
        "url": "https://api.cerebras.ai/v1/chat/completions",
        "env_key": "CEREBRAS_API_KEY",
    },
}

SYSTEM_PROMPT = (
    "Write a clear beginner study guide. Stay close to the requested length "
    "(about 800 words). Do not add a preamble or closing sales pitch."
)

app = FastAPI(title="OpenAI vs Cerebras comparison demo")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class StreamRequest(BaseModel):
    provider: str
    api_key: str = ""
    prompt: str = DEFAULT_PROMPT
    model: str = ""
    max_tokens: int = Field(default=1600, ge=200, le=4000)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/defaults")
async def defaults() -> dict[str, Any]:
    return {
        "prompt": DEFAULT_PROMPT,
        "max_tokens": 1600,
        "providers": {
            key: {
                "label": spec["label"],
                "model": spec["model"],
                "env_configured": bool(os.getenv(spec["env_key"], "").strip()),
            }
            for key, spec in PROVIDERS.items()
        },
        "cerebras_models": CEREBRAS_MODELS,
    }


def _resolve_key(provider: str, submitted: str) -> str:
    spec = PROVIDERS[provider]
    key = (submitted or "").strip() or os.getenv(spec["env_key"], "").strip()
    if not key:
        raise HTTPException(
            status_code=400,
            detail=f"Missing API key for {spec['label']}. Enter it in the matching key tab.",
        )
    return key


def _resolve_cerebras_model(submitted: str) -> str:
    model = (submitted or "").strip() or PROVIDERS["cerebras"]["model"]
    if model not in CEREBRAS_MODELS:
        raise HTTPException(
            status_code=400,
            detail="Unknown Cerebras model. Choose gpt-oss-120b or qwen-3.8-27b.",
        )
    return model


def _payload(provider: str, prompt: str, max_tokens: int, model: str) -> dict[str, Any]:
    spec = PROVIDERS[provider]
    body: dict[str, Any] = {
        "model": model or spec["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt.strip() or DEFAULT_PROMPT},
        ],
        "stream": True,
        "temperature": 0.4,
    }
    if provider == "openai":
        body["max_completion_tokens"] = max_tokens
        body["stream_options"] = {"include_usage": True}
    else:
        # Keep visible study-guide output closer to GPT-4.1 (no extra reasoning step).
        body["max_tokens"] = max_tokens
        body["reasoning_effort"] = CEREBRAS_MODELS[model]["reasoning_effort"]
        body["stream_options"] = {"include_usage": True}
    return body


def _extract_visible_text(delta: dict[str, Any]) -> str:
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    return ""


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _relay_stream(
    provider: str, api_key: str, prompt: str, max_tokens: int, model: str
) -> AsyncIterator[str]:
    spec = PROVIDERS[provider]
    label = spec["label"]
    if provider == "cerebras":
        label = CEREBRAS_MODELS[model]["label"]
    yield _sse(
        {
            "type": "meta",
            "provider": provider,
            "model": model or spec["model"],
            "label": label,
        }
    )

    timeout = httpx.Timeout(connect=20.0, read=180.0, write=30.0, pool=20.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                spec["url"],
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=_payload(provider, prompt, max_tokens, model),
            ) as response:
                if response.status_code >= 400:
                    error_body = (await response.aread()).decode("utf-8", errors="replace")
                    yield _sse(
                        {
                            "type": "error",
                            "message": _friendly_error(response.status_code, error_body),
                        }
                    )
                    return

                async for line in response.aiter_lines():
                    if not line:
                        continue
                    if line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    usage = chunk.get("usage")
                    if usage:
                        yield _sse({"type": "usage", "usage": usage})

                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    text = _extract_visible_text(delta)
                    if text:
                        yield _sse({"type": "delta", "text": text})

                    finish = choices[0].get("finish_reason")
                    if finish:
                        yield _sse({"type": "finish", "reason": finish})
    except httpx.TimeoutException:
        yield _sse({"type": "error", "message": "The provider timed out. Try again, or shorten the max tokens."})
        return
    except httpx.HTTPError as exc:
        yield _sse({"type": "error", "message": f"Network error reaching the provider: {exc}"})
        return

    yield _sse({"type": "done"})


def _friendly_error(status: int, body: str) -> str:
    try:
        parsed = json.loads(body)
        err = parsed.get("error")
        if isinstance(err, dict):
            message = err.get("message") or body
        elif isinstance(err, str):
            message = err
        else:
            message = parsed.get("message") or body
    except json.JSONDecodeError:
        message = body or f"HTTP {status}"
    message = str(message).strip() or f"HTTP {status}"
    if status == 401:
        return f"Authentication failed ({status}). Check the API key in the matching tab. {message}"
    if status == 429:
        return f"Rate limited ({status}). Wait a moment and retry. {message}"
    return f"Provider error ({status}): {message}"


@app.post("/api/stream")
async def stream(request: StreamRequest) -> StreamingResponse:
    provider = request.provider.strip().lower()
    if provider not in PROVIDERS:
        raise HTTPException(status_code=400, detail="Unknown provider. Use openai or cerebras.")

    api_key = _resolve_key(provider, request.api_key)
    prompt = request.prompt.strip() or DEFAULT_PROMPT
    model = PROVIDERS[provider]["model"]
    if provider == "cerebras":
        model = _resolve_cerebras_model(request.model)

    return StreamingResponse(
        _relay_stream(provider, api_key, prompt, request.max_tokens, model),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
