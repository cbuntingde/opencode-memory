"""Venv-aware launcher for MCP Memory.

Creates `.venv` on first run, installs dependencies, then starts the server.
Subsequent runs reuse the existing `.venv`.
"""

import os
import sys
import subprocess
from pathlib import Path


def get_python_executable() -> Path:
    """Get the Python executable to use for creating venv."""
    if sys.platform == "win32":
        pyLauncher = Path(sys.prefix) / "Scripts" / "py.exe"
        if pyLauncher.exists():
            return pyLauncher
    return Path(sys.executable)


def find_venv_python(project_root: Path) -> Path | None:
    """Return the venv Python interpreter if it exists."""
    if sys.platform == "win32":
        candidate = project_root / ".venv" / "Scripts" / "python.exe"
    else:
        candidate = project_root / ".venv" / "bin" / "python"
    if candidate.exists():
        return candidate
    return None


def ensure_venv(project_root: Path) -> Path:
    """Create `.venv` if missing, install deps, and return the venv Python path."""
    venv_dir = project_root / ".venv"
    python = find_venv_python(project_root)

    if python is None:
        print(f"[mcp-memory] Creating virtual environment at {venv_dir} ...")
        python_exec = get_python_executable()
        subprocess.check_call([str(python_exec), "-m", "venv", str(venv_dir)])

        if sys.platform == "win32":
            python = venv_dir / "Scripts" / "python.exe"
        else:
            python = venv_dir / "bin" / "python"
    else:
        print(f"[mcp-memory] Using existing virtual environment at {venv_dir}")

    print("[mcp-memory] Upgrading pip ...")
    subprocess.check_call([str(python), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])

    print("[mcp-memory] Installing dependencies into .venv ...")
    deps = [
        "fastmcp>=2.10.5",
        "python-dotenv>=1.0.0",
        "sentence-transformers>=2.2.0",
        "numpy>=1.21.0",
        "scipy>=1.7.0",
    ]
    subprocess.check_call([str(python), "-m", "pip", "install"] + deps)

    print("[mcp-memory] Installing mcp-memory package into .venv ...")
    subprocess.check_call([str(python), "-m", "pip", "install", "-e", str(project_root)])

    return python


def main():
    project_root = Path(__file__).resolve().parent.parent
    if not (project_root / "pyproject.toml").exists():
        project_root = Path.cwd()

    python = ensure_venv(project_root)

    server_module = "mcp_memory.server"
    args = [str(python), "-m", server_module] + sys.argv[1:]
    env = os.environ.copy()
    env["MCP_MEMORY_VENV"] = str(project_root / ".venv")
    raise SystemExit(subprocess.call(args, env=env))


if __name__ == "__main__":
    main()
