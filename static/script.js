(() => {
  const log = document.getElementById("log");
  const empty = document.getElementById("empty");
  const form = document.getElementById("composer");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const clearBtn = document.getElementById("clear");
  const themeBtn = document.getElementById("theme");
  const evalBtn = document.getElementById("evaluate");
  const topicBtns = document.querySelectorAll(".topic");

  let busy = false;

  /* ---------- Theme ---------- */
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeBtn.textContent = theme === "dark" ? "Light mode" : "Dark mode";
    try { localStorage.setItem("theme", theme); } catch (_) {}
  }

  let savedTheme = null;
  try { savedTheme = localStorage.getItem("theme"); } catch (_) {}
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(savedTheme || (prefersDark ? "dark" : "light"));

  themeBtn.addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  /* ---------- Safe markdown rendering ----------
     The model's answer is escaped first, then a small set of
     markdown features is turned back into HTML. No raw HTML from
     the server is ever inserted into the page. */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  }

  function renderTable(rows) {
    const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
    const isSeparator = (row) => /^\|?[\s:|-]+\|?$/.test(row) && row.includes("-");
    const body = rows.filter((r) => !isSeparator(r));
    if (!body.length) return "";
    const head = cells(body[0]).map((c) => `<th>${c}</th>`).join("");
    const rest = body.slice(1)
      .map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("");
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rest}</tbody></table></div>`;
  }

  function renderMarkdown(text) {
    const lines = escapeHtml(String(text).trim()).split("\n");
    let html = "";
    let list = null;
    let table = [];

    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    const closeTable = () => { if (table.length) { html += renderTable(table); table = []; } };

    for (const raw of lines) {
      const line = raw.trim();
      const ul = line.match(/^[-*•]\s+(.*)/);
      const ol = line.match(/^\d+[.)]\s+(.*)/);

      if (line.startsWith("|")) {
        closeList();
        table.push(line);
        continue;
      }
      closeTable();

      if (ul || ol) {
        const tag = ul ? "ul" : "ol";
        if (list !== tag) { closeList(); html += `<${tag}>`; list = tag; }
        html += `<li>${inline((ul || ol)[1])}</li>`;
      } else if (!line) {
        closeList();
      } else {
        closeList();
        html += `<p>${inline(line)}</p>`;
      }
    }
    closeList();
    closeTable();
    return html;
  }

  /* ---------- Message helpers ---------- */
  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function addUser(text) {
    const el = document.createElement("div");
    el.className = "msg user";
    el.textContent = text; // textContent: never parsed as HTML
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  function addBot(text) {
    const el = document.createElement("div");
    el.className = "msg bot";
    el.innerHTML = renderMarkdown(text);
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  function addTyping() {
    const el = document.createElement("div");
    el.className = "typing";
    el.setAttribute("aria-label", "The assistant is typing");
    el.innerHTML = "<span></span><span></span><span></span>";
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  function addError(message, question) {
    const el = document.createElement("div");
    el.className = "msg error";
    const p = document.createElement("p");
    p.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => {
      if (busy) return;
      const prev = el.previousElementSibling;
      if (prev && prev.classList.contains("user")) prev.remove();
      el.remove();
      ask(question);
    });
    el.append(p, retry);
    log.appendChild(el);
    scrollToEnd();
    return el;
  }

  /* ---------- State ---------- */
  function updateControls() {
    sendBtn.disabled = busy || input.value.trim() === "";
    topicBtns.forEach((b) => { b.disabled = busy; });
  }

  function setBusy(value) {
    busy = value;
    updateControls();
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  /* ---------- Ask the backend ---------- */
  async function ask(question) {
    question = question.trim();
    if (busy || !question) return;

    setBusy(true);
    empty.hidden = true;
    addUser(question);
    const typing = addTyping();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(
          res.status === 422
            ? "Your question is empty or longer than 1000 characters."
            : "The assistant hit an error. Try again in a moment."
        );
      }

      const data = await res.json();
      typing.remove();
      addBot(data.answer);
    } catch (err) {
      typing.remove();
      let message = err.message;
      if (err.name === "AbortError") message = "The assistant took too long to answer.";
      else if (err instanceof TypeError) message = "Can't reach the server. Check your connection.";
      addError(message, question);
    } finally {
      clearTimeout(timer);
      setBusy(false);
      input.focus();
    }
  }

  /* ---------- Events ---------- */
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const question = input.value;
    if (!question.trim() || busy) return;
    input.value = "";
    resizeInput();
    updateControls();
    ask(question);
  });

  input.addEventListener("keydown", (e) => {
    // Enter sends, Shift+Enter adds a new line
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener("input", () => {
    resizeInput();
    updateControls();
  });

  topicBtns.forEach((btn) => {
    btn.addEventListener("click", () => ask(btn.dataset.question));
  });

  clearBtn.addEventListener("click", () => {
    if (busy) return;
    log.querySelectorAll(".msg, .typing").forEach((el) => el.remove());
    empty.hidden = false;
    input.focus();
  });

  /* ---------- Evaluation button ---------- */
  let evalTimer = null;

  function setEvalRunning(running) {
    evalBtn.disabled = running;
    evalBtn.textContent = running ? "Evaluating..." : "Run evaluation";
  }

  function getEvalToken(forcePrompt) {
    let token = null;
    try { token = sessionStorage.getItem("evalToken"); } catch (_) {}
    if (!token || forcePrompt) {
      token = window.prompt("Enter the evaluation token");
      if (token) {
        try { sessionStorage.setItem("evalToken", token); } catch (_) {}
      }
    }
    return token;
  }

  function pollEvaluation() {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(async () => {
      try {
        const res = await fetch("/api/evaluate/status");
        const data = await res.json();
        if (data.state === "running") return pollEvaluation();
        setEvalRunning(false);
        empty.hidden = true;
        if (data.state === "done") {
          addBot("Evaluation finished. Open LangSmith, go to Datasets & Experiments, and open the latest hr-policy-eval experiment to see correctness and groundedness scores.");
        } else if (data.state === "error") {
          addError(data.error || "Evaluation failed.", "");
        }
      } catch (_) {
        pollEvaluation(); // network blip: keep polling
      }
    }, 3000);
  }

  evalBtn.addEventListener("click", async () => {
    const token = getEvalToken(false);
    if (!token) return;
    setEvalRunning(true);
    try {
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "X-Eval-Token": token },
      });
      if (res.status === 401) {
        try { sessionStorage.removeItem("evalToken"); } catch (_) {}
        setEvalRunning(false);
        empty.hidden = true;
        addError("Wrong evaluation token.", "");
        return;
      }
      if (res.status === 503) {
        setEvalRunning(false);
        empty.hidden = true;
        addError("Evaluation is disabled on the server. Set EVAL_TOKEN.", "");
        return;
      }
      // 202 = started, 409 = one is already running; both mean "keep polling"
      if (res.status !== 202 && res.status !== 409) throw new Error("bad status");
      empty.hidden = true;
      addBot("Evaluation started. This usually takes a few minutes. Keep this page open.");
      pollEvaluation();
    } catch (_) {
      setEvalRunning(false);
      empty.hidden = true;
      addError("Could not start the evaluation.", "");
    }
  });

  // If an evaluation is already running (page reload), resume the status check.
  fetch("/api/evaluate/status")
    .then((r) => r.json())
    .then((d) => { if (d.state === "running") { setEvalRunning(true); pollEvaluation(); } })
    .catch(() => {});

  updateControls();
})();