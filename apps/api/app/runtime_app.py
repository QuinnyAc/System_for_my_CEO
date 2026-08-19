from app.collector_app import app as collector_app
from app.main import app


# Serve browser-collector endpoints from the same API process as the main app.
# This removes the browser data path's dependency on cross-container networking.
app.mount("/collector", collector_app)
