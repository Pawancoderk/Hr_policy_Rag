"""FastAPI server for the HR Policy Assistant.

Replaces Streamlit (app.py). It does two jobs:
  1. POST /api/chat  -> runs the question through your existing RAG agent
  2. everything else -> serves the HTML/CSS/JS in the ./static folder

Run locally with:  uvicorn server:app --reload
"""

import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from hr_assistant.logger import get_logger
from hr_assistant.pipeline import ask, build_hr_assistant

logger = get_logger(__name__)

STATIC_DIR = Path(__file__).resolve().parent / "static"

# The agent is built once and shared by every request
# (same idea as @st.cache_resource in the Streamlit version).
_agent = None
_agent_lock = threading.Lock()


def get_agent():
    global _agent
    if _agent is None:
        with _agent_lock:
            if _agent is None:
                _agent = build_hr_assistant()
    return _agent


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Build the agent at startup so the first visitor doesn't wait for it.
    await run_in_threadpool(get_agent)
    yield


app = FastAPI(title="HR Policy Assistant", lifespan=lifespan)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000)


class ChatResponse(BaseModel):
    answer: str


@app.get("/api/health")
def health():
    return {"status": "ok"}


# A plain `def` endpoint runs in a worker thread, so the blocking
# agent call (LLM + Qdrant + guardrails) doesn't freeze the server.
@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest):
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is empty.")
    try:
        answer = ask(get_agent(), question)
    except Exception:
        logger.exception("Chat request failed")
        raise HTTPException(status_code=500, detail="The assistant hit an error.")
    return ChatResponse(answer=str(answer))



# ---------- Evaluation (triggered from the UI button) ----------
# Evaluation takes minutes, longer than one web request should last,
# so it runs in a background thread and the UI polls /api/evaluate/status.
# EVAL_TOKEN (set in your Modal secret / .env) stops strangers from
# starting runs that spend your Groq/Portkey credits.
EVAL_TOKEN = os.getenv("EVAL_TOKEN")

_eval_state = {"state": "idle", "started_at": None, "finished_at": None, "error": None}
_eval_lock = threading.Lock()


def _run_eval_job():
    try:
        from hr_assistant.evaluation import run_evaluation

        run_evaluation()
        with _eval_lock:
            _eval_state.update(state="done", finished_at=time.time(), error=None)
    except Exception:
        logger.exception("Evaluation failed")
        with _eval_lock:
            _eval_state.update(
                state="error",
                finished_at=time.time(),
                error="Evaluation failed. Check the server logs.",
            )


@app.post("/api/evaluate", status_code=202)
def start_evaluation(x_eval_token: str | None = Header(default=None)):
    if not EVAL_TOKEN:
        raise HTTPException(status_code=503, detail="Evaluation is disabled. Set EVAL_TOKEN.")
    if not secrets.compare_digest((x_eval_token or "").encode(), EVAL_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Wrong token.")
    with _eval_lock:
        if _eval_state["state"] == "running":
            raise HTTPException(status_code=409, detail="An evaluation is already running.")
        _eval_state.update(state="running", started_at=time.time(), finished_at=None, error=None)
        snapshot = dict(_eval_state)
    threading.Thread(target=_run_eval_job, daemon=True).start()
    return snapshot


@app.get("/api/evaluate/status")
def evaluation_status():
    with _eval_lock:
        return dict(_eval_state)


# Must be registered last, so it doesn't shadow the /api routes.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")