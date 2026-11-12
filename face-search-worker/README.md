# Face Search Worker

Python BullMQ consumer for the portal's face-search queue. The worker runs on a separate computer and connects **outbound** to the same Redis instance used by the deployed `face-search-queue` API. It does not expose an HTTP server and does not need a tunnel or inbound port forwarding.

## 🏗️ Architecture

```
face-search-worker/
├── worker.py              # Main worker orchestrator
├── core/                  # Shared core functionality
│   ├── base_engine.py    # Abstract base class for engines
│   ├── worker_manager.py # Worker lifecycle management
│   └── job_processor.py  # Job processing logic
├── engines/              # Face recognition engines
│   ├── deepface/        # DeepFace engine (TensorFlow)
│   │   ├── engine.py
│   │   └── requirements.txt
│   └── face_recognition/ # face_recognition engine (dlib)
│       ├── engine.py
│       └── requirements.txt
├── exclude_faces/        # Shared exclude faces directory
├── metrics.py           # System metrics collection
├── deploy.bat           # Windows deployment script
├── deploy.sh            # Linux/Mac deployment script
└── .env                 # Configuration
```

## Setup on a separate worker computer

### 1. Prepare the gallery files

The worker reads the original gallery photos from disk; it does not download them from Vercel or Google Drive. Copy the gallery tree to this computer and preserve the directory names and filenames. The root must contain folders in this shape:

```text
<gallery-root>/
└── 20-11-2025 Day 2/
    └── 09.30AM to 01PM/
        └── Station 1 (Right)/
            ├── photo-name.jpg
            └── ...
```

Each face-search job contains the selected `day/time/stage` path. The worker scans `<gallery-root>/<day>/<time>/<stage>` and returns relative file paths, so names must match the paths and filenames the portal gets from Drive.

### 2. Install Python and dependencies (CPU starter setup)

Use 64-bit Python 3.11. Python 3.14 is too new for the TensorFlow dependency in this worker, and the pinned NumPy version also has no Python 3.14 wheel. Install [`uv`](https://docs.astral.sh/uv/getting-started/installation/) first, then create a Python 3.11 environment and install the dependencies from the repository root.

Linux/macOS:

```bash
uv python install 3.11
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r engines/deepface/requirements.txt
```

Windows PowerShell:

```powershell
cd face-search-worker
uv python install 3.11
uv venv --python 3.11 .venv
uv pip install --python .venv\Scripts\python.exe -r engines/deepface/requirements.txt
```

The DeepFace requirements install DeepFace 0.0.104, TensorFlow 2.21.0, and its matching `tf-keras` package. DeepFace requires `tf-keras` with TensorFlow 2.16 and newer. The first face-search run may download model weights; keep the worker online until that first job finishes.

### 3. Configure the worker

Copy the example file and edit it:

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, and `REDIS_TLS` to the same Redis endpoint and credentials configured on the **face-search-queue Vercel project**. Use the host only (no `redis://` or `rediss://` prefix). Set `REDIS_TLS=true` when your Redis provider requires TLS; otherwise use `false`.

Set `CONVOCATION_PHOTOS_DIR` to the gallery root on this computer. Forward slashes work in Windows paths, for example `C:/FaceSearch/Jain 15th Convocation`. Start with `USE_CPU=1` and `WORKER_CONCURRENCY=1`.

### 4. Start the worker

From the `face-search-worker` directory:

```powershell
.venv\Scripts\python.exe worker.py --engine deepface
```

Leave this terminal open. A running worker should log that Redis connected, show a worker ID, and say it is waiting for jobs. In the queue dashboard, it should appear as online. Stop it with `Ctrl+C`.

### GPU setup (optional)

First make CPU processing work. For an NVIDIA GPU on Linux or Windows with WSL2, install and verify the NVIDIA driver, then install TensorFlow's CUDA dependencies in the worker's Python environment and set `USE_CPU=0`. Windows native TensorFlow GPU is not supported after TensorFlow 2.10; use WSL2 for current TensorFlow GPU support. See [TensorFlow's install guide](https://www.tensorflow.org/install/pip) for the current driver and platform requirements.

### Use `face_recognition` instead

The alternative engine depends on `dlib`, which may require platform-specific native build tools. Install `engines/face_recognition/requirements.txt` in a compatible environment, then launch with `python worker.py --engine face_recognition`. For an initial Windows setup, DeepFace is the simpler path.

## Network and Vercel configuration

- Deploy `face-search-queue` as its own Vercel project and configure its Redis environment variables there. The portal submits jobs to its queue API; the worker consumes jobs directly from Redis.
- Configure the portal's build-time `VITE_QUEUE_FALLBACK_URL` to the queue deployment's base URL if it is not `https://face-search-queue.vercel.app`. The frontend also probes `https://face-search.<portal-host>/api` first.
- The worker computer needs outbound access to the Redis host and port. Do not open an inbound port on the computer or point Redis at `localhost`.
- Use a dedicated, password-protected Redis instance reachable by both Vercel and the worker, with TLS when supported. BullMQ recommends Redis `maxmemory-policy=noeviction`.
- Keep `.env` private; only commit `.env.example`. The Redis password must never be placed in a `VITE_*` variable or frontend code.

## 🎯 How It Works

### 1. Worker Initialization
- Connects to Redis
- Registers worker with unique ID (auto-indexed based on active workers)
- Starts heartbeat thread (5-second interval)
- Loads selected engine dynamically

### 2. Job Processing
```
Job Received → Check Pause Status → Load Exclude Faces → 
Process Gallery Images → Calculate Similarities → 
Return Sorted Results (Best Matches First)
```

### 3. Face Matching Algorithm
- **Not**: Finding top N matches
- **Is**: Calculating similarity % for ALL gallery images
- **Returns**: Dict of `{id: similarity}` sorted in descending order
- **Uses**: `face_distance` to calculate similarity scores

### 4. Exclude Faces
- Shared `exclude_faces/` directory for both engines
- Worker passes file paths to engine
- Engine handles exclusion logic
- Filters out matching faces from results

## 🔧 Engine Details

### DeepFace Engine
- **Backend**: TensorFlow
- **Models**: VGG-Face, Facenet, OpenFace, DeepID, etc.
- **Method**: Embedding-based similarity (cosine distance)
- **GPU**: CUDA accelerated
- **Dependencies**: `tensorflow`, `deepface`, `opencv-python`

### face_recognition Engine
- **Backend**: dlib
- **Method**: Face encoding + distance calculation
- **GPU**: CUDA accelerated via dlib
- **Speed**: Faster than DeepFace
- **Accuracy**: High (based on ResNet)
- **Dependencies**: `face_recognition`, `dlib`, `opencv-python`

## 📤 API Response Format

Jobs return sorted list of ALL matches:

```json
[
  { "id": "photo_001.jpg", "similarity": 0.9523 },
  { "id": "photo_042.jpg", "similarity": 0.8734 },
  { "id": "photo_123.jpg", "similarity": 0.8201 },
  { "id": "photo_456.jpg", "similarity": 0.7856 },
  ...
]
```

**Sorted**: Descending order (best matches at top)  
**Similarity**: 0.0 to 1.0 (1.0 = perfect match)

## 🚫 Exclude Faces

Place images to exclude in `exclude_faces/`:

```
exclude_faces/
├── staff_member1.jpg
├── staff_member2.jpg
├── photographer.jpg
└── unwanted/
    ├── group1.jpg
    └── group2.jpg
```

These faces are automatically filtered from all results.

## 📊 Monitoring

Workers report metrics every 5 seconds:
- **System**: CPU, RAM, GPU usage & temperature
- **Jobs**: Processed count, failed count, current job
- **Status**: Online/offline, paused/running
- **Uptime**: Time since worker started

**View in Queue UI**: http://localhost:3000

## 🎛️ Worker Controls

### Pause/Resume
- Click pause button (⏸️) in Queue UI
- Worker checks pause flag before each job
- Paused jobs delayed (not failed!)
- Resume to continue processing

### Worker ID Format
```
{hostname}_{type}_{engine}_{number}
```

Examples:
- `LAPTOP_gpu0_deepface_1`
- `LAPTOP_gpu0_face_recognition_2`

IDs auto-index based on **active** workers (reuses slots when workers stop).

## 🛠️ Troubleshooting

**Import errors**  
→ Ensure correct conda environment activated

**GPU not detected**  
→ Check `nvidia-smi` and CUDA installation

**Worker not showing in UI**  
→ Check Redis connection and heartbeat logs

**Jobs failing**  
→ Check logs, verify engine dependencies installed

**"No face detected" errors**  
→ Ensure selfie has clear, visible face  
→ Try different lighting/angle

## 🔄 Signal Handling

Worker handles graceful shutdown:
- **SIGINT** (Ctrl+C): Completes current job, then exits
- **SIGTERM**: Same as SIGINT
- **Cleanup**: Removes worker from Redis, clears pause flags

## 📁 Shared Resources

### Core Modules
- `base_engine.py`: Abstract interface all engines implement
- `worker_manager.py`: Lifecycle, registration, heartbeat, cleanup
- `job_processor.py`: Job processing logic with pause checks

### Engine Interface
All engines must implement:
```python
class Engine(BaseEngine):
    def search_faces(
        selfie_base64: str,
        gallery_images: List[Dict],
        exclude_images: List[str]
    ) -> List[Dict[str, float]]:
        # Return sorted results
        pass
```

## 🚀 Production Deployment

### Multiple Workers
Run multiple workers for load balancing:
```bash
# Terminal 1
conda activate tf
python worker.py --engine deepface

# Terminal 2
conda activate ml
python worker.py --engine face_recognition
```

### Auto-Restart (Linux/systemd)
```ini
[Unit]
Description=Face Search Worker (DeepFace)
After=network.target redis.service

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/face-search-worker
ExecStart=/path/to/conda/envs/tf/bin/python worker.py --engine deepface
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## 📝 Development

### Adding New Engine

1. Create `engines/new_engine/` directory
2. Create `engine.py` implementing `BaseEngine`
3. Create `requirements.txt`
4. Update `worker.py` engine loading logic

### Testing

```bash
# Test engine directly
python -c "from engines.face_recognition.engine import FaceRecognitionEngine; e = FaceRecognitionEngine(); print(e.name)"

# Test with mock job
python worker.py --engine face_recognition
# Create test job via Queue UI
```

## 📄 License

Part of Jain-Convocation-Portal project.
