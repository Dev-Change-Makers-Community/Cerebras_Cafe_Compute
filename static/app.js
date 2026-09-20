const DEFAULT_PROMPT =
  "Create a beginner-friendly study guide on Python functions. Include five key concepts with explanations, three runnable code examples, five practice exercises, and an answer key. Target approximately 800 words.";

const promptEl = document.getElementById("prompt");
const runEl = document.getElementById("run");
const stopEl = document.getElementById("stop");
const maxTokensEl = document.getElementById("max-tokens");
const verdictEl = document.getElementById("verdict");
const verdictCopyEl = document.getElementById("verdict-copy");
const openaiKeyEl = document.getElementById("openai-key");
const cerebrasKeyEl = document.getElementById("cerebras-key");

const lanes = {
  openai: createLane("openai"),
  cerebras: createLane("cerebras"),
};

let activeControllers = [];

promptEl.value = DEFAULT_PROMPT;
restoreKeys();

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

document.querySelectorAll("[data-toggle-key]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.toggleKey);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    button.textContent = hidden ? "Hide" : "Show";
  });
});

openaiKeyEl.addEventListener("input", () => persistKey("openai", openaiKeyEl.value));
cerebrasKeyEl.addEventListener("input", () => persistKey("cerebras", cerebrasKeyEl.value));

runEl.addEventListener("click", () => {
  void runComparison();
});
stopEl.addEventListener("click", stopAll);

function createLane(id) {
  const root = document.querySelector(`[data-lane="${id}"]`);
  return {
    id,
    root,
    output: root.querySelector("[data-output]"),
    ttft: root.querySelector('[data-metric="ttft"]'),
    total: root.querySelector('[data-metric="total"]'),
    tokens: root.querySelector('[data-metric="tokens"]'),
  };
}

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".key-panel").forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

function persistKey(provider, value) {
  sessionStorage.setItem(`demo-key-${provider}`, value);
}

function restoreKeys() {
  openaiKeyEl.value = sessionStorage.getItem("demo-key-openai") || "";
  cerebrasKeyEl.value = sessionStorage.getItem("demo-key-cerebras") || "";
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function resetLane(lane) {
  lane.root.classList.remove("is-running", "is-error", "is-done");
  lane.output.textContent = "";
  lane.ttft.textContent = "—";
  lane.total.textContent = "0.00 s";
  lane.tokens.textContent = "—";
  lane.ttft.dataset.live = "true";
  lane.total.dataset.live = "true";
}

function stopAll() {
  activeControllers.forEach((controller) => controller.abort());
  activeControllers = [];
  runEl.disabled = false;
  stopEl.hidden = true;
}

async function runComparison() {
  stopAll();
  verdictEl.hidden = true;
  runEl.disabled = true;
  stopEl.hidden = false;

  Object.values(lanes).forEach(resetLane);

  const prompt = promptEl.value.trim() || DEFAULT_PROMPT;
  const maxTokens = Number(maxTokensEl.value) || 1600;
  const results = await Promise.all([
    streamProvider("openai", openaiKeyEl.value, prompt, maxTokens),
    streamProvider("cerebras", cerebrasKeyEl.value, prompt, maxTokens),
  ]);

  runEl.disabled = false;
  stopEl.hidden = true;
  renderVerdict(results);
}

async function streamProvider(provider, apiKey, prompt, maxTokens) {
  const lane = lanes[provider];
  const controller = new AbortController();
  activeControllers.push(controller);
  lane.root.classList.add("is-running");

  const started = performance.now();
  let firstVisible = null;
  let outputTokens = null;
  let timer = window.setInterval(() => {
    if (firstVisible == null) {
      lane.ttft.textContent = formatMs(performance.now() - started);
    }
    lane.total.textContent = formatMs(performance.now() - started);
  }, 50);

  try {
    const response = await fetch("/api/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        provider,
        api_key: apiKey,
        prompt,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const detail = await readError(response);
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part
          .split("\n")
          .filter((row) => row.startsWith("data:"))
          .map((row) => row.slice(5).trim())
          .join("");
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "delta" && event.text) {
          if (firstVisible == null) {
            firstVisible = performance.now() - started;
            lane.ttft.textContent = formatMs(firstVisible);
          }
          lane.output.textContent += event.text;
          lane.output.scrollTop = lane.output.scrollHeight;
        } else if (event.type === "usage" && event.usage) {
          outputTokens =
            event.usage.completion_tokens ??
            event.usage.output_tokens ??
            outputTokens;
          if (outputTokens != null) {
            lane.tokens.textContent = String(outputTokens);
          }
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    }

    const total = performance.now() - started;
    if (firstVisible == null) {
      firstVisible = total;
      lane.ttft.textContent = formatMs(firstVisible);
    }
    lane.total.textContent = formatMs(total);
    if (outputTokens == null) {
      lane.tokens.textContent = estimateTokens(lane.output.textContent);
    }
    lane.root.classList.remove("is-running");
    lane.root.classList.add("is-done");
    return { provider, ok: true, firstVisible, total, outputTokens };
  } catch (error) {
    if (error.name === "AbortError") {
      lane.output.textContent += lane.output.textContent ? "\n\n[stopped]" : "[stopped]";
      return { provider, ok: false, firstVisible, total: performance.now() - started };
    }
    lane.root.classList.add("is-error");
    lane.output.textContent = error.message || "Request failed.";
    lane.ttft.textContent = "—";
    lane.total.textContent = formatMs(performance.now() - started);
    return { provider, ok: false, error: error.message };
  } finally {
    window.clearInterval(timer);
    lane.ttft.dataset.live = "false";
    lane.total.dataset.live = "false";
    lane.root.classList.remove("is-running");
  }
}

function estimateTokens(text) {
  if (!text) return "0 est.";
  return `${Math.max(1, Math.round(text.length / 4))} est.`;
}

async function readError(response) {
  try {
    const payload = await response.json();
    return payload.detail || JSON.stringify(payload);
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function renderVerdict(results) {
  const openai = results.find((item) => item.provider === "openai");
  const cerebras = results.find((item) => item.provider === "cerebras");
  if (!openai?.ok || !cerebras?.ok) {
    verdictEl.hidden = false;
    verdictCopyEl.textContent =
      "One or both streams did not finish. Fix the key or error in the panel, then run again. Do not quote a speedup from a partial rehearsal.";
    return;
  }

  const ttftRatio = openai.firstVisible / cerebras.firstVisible;
  const totalRatio = openai.total / cerebras.total;
  const fasterTotal = cerebras.total < openai.total ? "Cerebras" : "OpenAI";
  const fasterFirst = cerebras.firstVisible < openai.firstVisible ? "Cerebras" : "OpenAI";

  verdictEl.hidden = false;
  verdictCopyEl.textContent =
    `Measured on this machine, this run: first visible answer was ${fasterFirst} ` +
    `(OpenAI ${formatMs(openai.firstVisible)} vs Cerebras ${formatMs(cerebras.firstVisible)}, ` +
    `${ttftRatio.toFixed(2)}×). Total completion was ${fasterTotal} ` +
    `(OpenAI ${formatMs(openai.total)} vs Cerebras ${formatMs(cerebras.total)}, ` +
    `${totalRatio.toFixed(2)}×). Re-run a few times before you mention any number.`;
}
