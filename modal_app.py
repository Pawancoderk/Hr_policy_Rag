import modal

# 1) Image: what goes inside the container
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install_from_requirements("requirements-modal.txt")
   
    .add_local_python_source("hr_assistant")
    .add_local_file("server.py", "/root/server.py")
    .add_local_dir("static", "/root/static")
    .add_local_dir("data", "/root/data")
)

# 2) App: ties the image and secrets together
app = modal.App(
    "hr-assistant",
    image=image,
    secrets=[modal.Secret.from_name("hr-assistant-secrets")],
)



@app.function(
    scaledown_window=300,  
    timeout=600,
   
)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def web():
    import os
    import sys

   
    os.chdir("/root")
    sys.path.insert(0, "/root")

    from server import app as fastapi_app

    return fastapi_app


# 4) One-off job: replaces `docker compose run eval`
@app.function(timeout=1800)
def run_eval():
    from hr_assistant.evaluation import run_evaluation

    run_evaluation()
    print("Evaluation done, check LangSmith.")