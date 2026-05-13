import argparse
import json
import re
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path


ROOT = Path.cwd()
PYTHON_ROOT = ROOT / "python"
DIST = PYTHON_ROOT / "dist"
LOCAL_PATH_RE = re.compile(r"(?<![A-Za-z])(?:[A-Za-z]:[\\/]|file://|\\\\\?\\)")


def read_text(path):
    return path.read_text(encoding="utf-8")


def package_version():
    text = read_text(PYTHON_ROOT / "audrey_memory" / "_version.py")
    match = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not match:
        raise RuntimeError("python/audrey_memory/_version.py is missing __version__")
    return match.group(1)


def pyproject_name():
    text = read_text(PYTHON_ROOT / "pyproject.toml")
    match = re.search(r'^name\s*=\s*"([^"]+)"', text, re.MULTILINE)
    if not match:
        raise RuntimeError("python/pyproject.toml is missing project name")
    return match.group(1)


def metadata_value(text, key):
    match = re.search(rf"^{re.escape(key)}:\s*(.+)$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def metadata_values(text, key):
    return re.findall(rf"^{re.escape(key)}:\s*(.+)$", text, re.MULTILINE)


def ensure(condition, message, failures):
    if not condition:
        failures.append(message)


def check_local_paths(label, values, failures):
    for value in values:
        if LOCAL_PATH_RE.search(value):
            failures.append(f"{label} contains local absolute path: {value}")


def wheel_metadata(wheel_path, version, failures):
    expected = {
        "audrey_memory/__init__.py",
        "audrey_memory/_version.py",
        "audrey_memory/client.py",
        "audrey_memory/types.py",
        "audrey_memory/py.typed",
        f"audrey_memory-{version}.dist-info/METADATA",
        f"audrey_memory-{version}.dist-info/WHEEL",
        f"audrey_memory-{version}.dist-info/RECORD",
    }
    with zipfile.ZipFile(wheel_path) as wheel:
        names = set(wheel.namelist())
        metadata = wheel.read(f"audrey_memory-{version}.dist-info/METADATA").decode("utf-8")
        wheel_info = wheel.read(f"audrey_memory-{version}.dist-info/WHEEL").decode("utf-8")

    missing = sorted(expected - names)
    ensure(not missing, f"wheel is missing expected files: {', '.join(missing)}", failures)
    check_local_paths("wheel filename", names, failures)
    check_local_paths("wheel metadata", [metadata, wheel_info], failures)
    return metadata, wheel_info, sorted(names)


def sdist_metadata(sdist_path, version, failures):
    prefix = f"audrey_memory-{version}/"
    expected = {
        f"{prefix}README.md",
        f"{prefix}pyproject.toml",
        f"{prefix}audrey_memory/__init__.py",
        f"{prefix}audrey_memory/_version.py",
        f"{prefix}audrey_memory/client.py",
        f"{prefix}audrey_memory/types.py",
        f"{prefix}audrey_memory/py.typed",
        f"{prefix}audrey_memory.egg-info/PKG-INFO",
    }
    with tarfile.open(sdist_path, "r:gz") as sdist:
        names = set(sdist.getnames())
        pkg_info_file = sdist.extractfile(f"{prefix}audrey_memory.egg-info/PKG-INFO")
        if pkg_info_file is None:
            raise RuntimeError("sdist is missing PKG-INFO")
        pkg_info = pkg_info_file.read().decode("utf-8")

    missing = sorted(expected - names)
    ensure(not missing, f"sdist is missing expected files: {', '.join(missing)}", failures)
    check_local_paths("sdist filename", names, failures)
    check_local_paths("sdist metadata", [pkg_info], failures)
    return pkg_info, sorted(names)


def check_metadata(label, text, name, version, failures):
    ensure(metadata_value(text, "Name") == name, f"{label} Name is not {name}", failures)
    ensure(metadata_value(text, "Version") == version, f"{label} Version is not {version}", failures)
    ensure(metadata_value(text, "Requires-Python") == ">=3.9", f"{label} Requires-Python is not >=3.9", failures)
    requires = metadata_values(text, "Requires-Dist")
    ensure(any(value.startswith("httpx") for value in requires), f"{label} is missing httpx dependency", failures)
    ensure(any(value.startswith("pydantic") for value in requires), f"{label} is missing pydantic dependency", failures)


def twine_check(paths):
    command = [sys.executable, "-m", "twine", "check", *[str(path) for path in paths]]
    return subprocess.run(command, cwd=ROOT, capture_output=True, text=True)


def public_path(path):
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def public_output(text):
    if not text:
        return ""
    return text.replace(str(ROOT), ".").replace(ROOT.as_posix(), ".")


def verify(version=None, skip_twine=False):
    version = version or package_version()
    name = pyproject_name()
    wheel_path = DIST / f"audrey_memory-{version}-py3-none-any.whl"
    sdist_path = DIST / f"audrey_memory-{version}.tar.gz"
    failures = []

    ensure(wheel_path.exists(), f"missing wheel: {wheel_path.as_posix()}", failures)
    ensure(sdist_path.exists(), f"missing sdist: {sdist_path.as_posix()}", failures)

    wheel_files = []
    sdist_files = []
    if wheel_path.exists():
        wheel_meta, _wheel_info, wheel_files = wheel_metadata(wheel_path, version, failures)
        check_metadata("wheel METADATA", wheel_meta, name, version, failures)
    if sdist_path.exists():
        sdist_meta, sdist_files = sdist_metadata(sdist_path, version, failures)
        check_metadata("sdist PKG-INFO", sdist_meta, name, version, failures)

    twine = None
    if not skip_twine and wheel_path.exists() and sdist_path.exists():
        result = twine_check([wheel_path, sdist_path])
        twine = {
            "ok": result.returncode == 0,
            "stdout": public_output(result.stdout.strip()),
            "stderr": public_output(result.stderr.strip()),
        }
        if result.returncode != 0:
            failures.append(f"twine check failed: {result.stderr.strip() or result.stdout.strip()}")

    return {
        "schemaVersion": "1.0.0",
        "suite": "Audrey Python package verification",
        "ok": not failures,
        "packageName": name,
        "version": version,
        "wheel": public_path(wheel_path),
        "sdist": public_path(sdist_path),
        "wheelFiles": wheel_files,
        "sdistFiles": sdist_files,
        "twine": twine,
        "failures": failures,
    }


def main():
    parser = argparse.ArgumentParser(description="Verify Audrey Python wheel/sdist release artifacts.")
    parser.add_argument("--version", default=None)
    parser.add_argument("--skip-twine", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    report = verify(version=args.version, skip_twine=args.skip_twine)
    if args.json:
        print(json.dumps(report, indent=2))
    elif report["ok"]:
        twine_status = "twine skipped" if report["twine"] is None else "twine passed"
        print(f"Python package verification passed: {report['packageName']} {report['version']} ({twine_status})")
    else:
        print("Python package verification failed:", file=sys.stderr)
        for failure in report["failures"]:
            print(f"- {failure}", file=sys.stderr)

    if not report["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
