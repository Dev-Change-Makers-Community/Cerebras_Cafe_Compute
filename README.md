# GPT-4.1 vs GPT OSS 120B comparison demo

A local rehearsal board for two **different** model-and-provider combinations:

| Panel label | Provider | Model | Why this pairing |
| --- | --- | --- | --- |
| **GPT-4.1 · OpenAI API** | [OpenAI Developer platform](https://platform.openai.com) | `gpt-4.1` | A straightforward baseline for text and code generation, without an extra reasoning step. |
| **GPT OSS 120B · Cerebras API** | [Cerebras Inference](https://inference-docs.cerebras.ai) | `gpt-oss-120b` | The faster of the two models in Cerebras’ catalog by advertised token-generation speed — approximately 3,000 tokens/second. |

Both sides use the **same prompt**, **streaming enabled**, and a **shared max-token cap** so output lengths stay in the same band. The UI records:

- **First visible** — time until the first answer text appears
- **Total time** — time until that stream finishes
- **Output tokens** — provider usage when available, otherwise a rough estimate

This is **not** “the same model on two hosts.” Quote only numbers you measure during rehearsals. Do not promise a specific speedup from the advertised 3,000 tok/s figure.

Sources: [OpenAI GPT-4.1 documentation](https://developers.openai.com/api/docs/models/gpt-4.1), [Cerebras model catalog](https://inference-docs.cerebras.ai/models/openai-oss).

## What you need

- Python 3.10 or newer
- An **OpenAI Developer platform API key** (for the OpenAI tab)
- A **Cerebras API key** (for the Cerebras tab)

## 1. Install

From this folder, in PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

If `py` is not available, use `python` instead of `py -3`.

On macOS or Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

## 2. Get the two API keys

### OpenAI tab — Developer platform key

1. Sign in at [platform.openai.com](https://platform.openai.com).
2. Open [API keys](https://platform.openai.com/api-keys) and create a secret key.
3. Confirm the project can call `gpt-4.1` and has available credit.

### Cerebras tab — Cerebras API key

1. Sign in at [cloud.cerebras.ai](https://cloud.cerebras.ai).
2. Create an API key for Cerebras Inference.
3. Confirm `gpt-oss-120b` is available on your account.

Keep both keys off slides, screenshots, and git. They are stored only in this browser tab’s `sessionStorage` and are forwarded from the local server to the official APIs.

Optional: copy `.env.example` to `.env` and fill `OPENAI_API_KEY` / `CEREBRAS_API_KEY` if you want the server to supply a missing tab. The on-screen tabs still win when they have a value.

## 3. Start the demo

```powershell
python -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

If the venv is not activated:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## 4. Run the study-guide prompt

1. Open the **OpenAI Developer platform** tab and paste your OpenAI key.
2. Switch to the **Cerebras API** tab and paste your Cerebras key.
3. Leave the shared prompt as:

   > Create a beginner-friendly study guide on Python functions. Include five key concepts with explanations, three runnable code examples, five practice exercises, and an answer key. Target approximately 800 words.

4. Keep **Max tokens** at `1600` (enough for ~800 words on both sides).
5. Click **Run both streams**.
6. Watch first-visible and total times update while text streams into each panel.

## How to read the board

- **GPT-4.1 · OpenAI API** is the non-reasoning baseline.
- **GPT OSS 120B · Cerebras API** uses `reasoning_effort: low` so the visible study guide is closer in shape to GPT-4.1. The default for this Cerebras model is `medium` reasoning; that would add hidden work before the first visible sentence.
- When both streams finish, the footer reports **this run only**. Repeat a few times on the machine you will present from. Network jitter, queueing, and different models all move the numbers.

## Rehearsal checklist

- [ ] Both keys accepted (no 401 in either panel)
- [ ] Same prompt, streaming on, same max-token cap
- [ ] First visible token and total time recorded for **both** panels
- [ ] Output lengths are similar enough to compare (adjust max tokens if one side cuts off)
- [ ] You have 2–3 measured runs before you mention any speedup
- [ ] You describe it as GPT-4.1 on OpenAI vs GPT OSS 120B on Cerebras — not “Cerebras is N× faster than GPT-4.1” as a general claim

## Project layout

```
app.py              Local FastAPI proxy (streams both providers)
static/index.html   Two-panel comparison UI and API-key tabs
static/app.js       Timing, streaming, and this-run summary
static/styles.css   Layout
requirements.txt    Python dependencies
.env.example        Optional key fallbacks
```

The browser cannot call OpenAI or Cerebras directly (CORS). `app.py` is a same-machine proxy only. It does not log keys.
