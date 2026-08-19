The Docker API service starts `app.runtime_app:app`, which mounts the existing collector FastAPI app at `/collector`. Browser-facing collector requests are forwarded through the main API process.
