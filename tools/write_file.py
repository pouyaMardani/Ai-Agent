import os
import tempfile
from pathlib import Path


class WriteFileTool:
    name = "write_file"
    max_bytes = 200 * 1024
    allowed_suffixes = (".txt", ".md", ".json", ".csv")
    blocked_suffixes = (".pem", ".key", ".pfx", ".p12", ".crt", ".cer", ".env")
    blocked_name_parts = (
        "id_rsa",
        "id_ed25519",
        "private_key",
        "credentials",
        "secret",
        "password",
        "passwd",
        "apikey",
        "api_key",
    )
    blocked_folder_parts = (
        ".git",
        ".ssh",
        ".venv",
        "__pycache__",
        "venv",
        "node_modules",
    )

    def __init__(self, workspace_dir=None):
        self.workspace_dir = Path(workspace_dir) if workspace_dir else Path(__file__).resolve().parent.parent / "workspace"

    def ensure_workspace(self):
        try:
            self.workspace_dir.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            print(f"[workspace] could not create {self.workspace_dir.name}/: {error}", flush=True)

    def get_schema(self):
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": (
                    "Create or replace a small text file inside the workspace folder. Use "
                    "a path relative to the workspace, for example 'notes.md' or "
                    "'reports/2024/summary.md'; missing folders inside the workspace are "
                    "created for you. Only .txt, .md, .json and .csv files up to 200 KB "
                    "are allowed. A file that already exists is NOT replaced unless "
                    "overwrite is true. This tool can never rename, move, or delete "
                    "anything."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "File path inside the workspace folder, e.g. 'notes.md'.",
                        },
                        "content": {
                            "type": "string",
                            "description": "The complete new text of the file.",
                        },
                        "overwrite": {
                            "type": "boolean",
                            "default": False,
                            "description": (
                                "Replace the file when it already exists. Defaults to false, "
                                "which refuses to replace anything."
                            ),
                        },
                    },
                    "required": ["path", "content"],
                    "additionalProperties": False,
                },
            },
        }

    def execute(self, arguments, root=None):
        path = arguments.get("path")
        if not isinstance(path, str):
            return {"ok": False, "error": "The 'path' argument must be a text string."}
        content = arguments.get("content")
        if not isinstance(content, str):
            return {"ok": False, "error": "The 'content' argument must be a text string."}
        overwrite = arguments.get("overwrite", False)
        if not isinstance(overwrite, bool):
            return {"ok": False, "error": "The 'overwrite' argument must be true or false."}

        root_dir = (self.workspace_dir if root is None else Path(root)).resolve()
        relative_path = path.strip()
        if not relative_path:
            return {"ok": False, "error": "No file path was given."}
        if len(relative_path) > 300 or "\x00" in relative_path:
            return {"ok": False, "error": "That path is not allowed."}
        if relative_path.startswith(("/", "\\")):
            return {"ok": False, "error": "Only paths inside the workspace folder are allowed."}

        candidate = Path(relative_path)
        if candidate.is_absolute() or candidate.drive:
            return {"ok": False, "error": "Only paths inside the workspace folder are allowed."}
        if ".." in candidate.parts:
            return {"ok": False, "error": "Paths containing '..' are not allowed."}
        for part in candidate.parts:
            if part.startswith("."):
                return {"ok": False, "error": "Hidden files and folders are not allowed."}
            lowered = part.lower()
            if any(blocked in lowered for blocked in self.blocked_name_parts):
                return {"ok": False, "error": "That file name looks like it could hold secrets, so it is blocked."}
            if lowered in self.blocked_folder_parts:
                return {"ok": False, "error": "That folder is not allowed inside the workspace."}

        target = root_dir / candidate
        existing = target if target.exists() else target.parent
        resolved = existing.resolve()
        if resolved != root_dir and root_dir not in resolved.parents:
            return {"ok": False, "error": "That file is outside the workspace folder."}
        if target.is_symlink() or target.parent.is_symlink():
            return {"ok": False, "error": "Symbolic links are not allowed inside the workspace."}
        if target.is_dir():
            return {"ok": False, "error": "That path is a folder, not a file."}

        suffix = target.suffix.lower()
        if suffix in self.blocked_suffixes:
            return {"ok": False, "error": "That type of file is blocked."}
        if suffix not in self.allowed_suffixes:
            allowed = ", ".join(self.allowed_suffixes)
            return {"ok": False, "error": f"Only these file types can be written: {allowed}."}

        data = content.encode("utf-8")
        if len(data) > self.max_bytes:
            limit_kb = self.max_bytes // 1024
            return {"ok": False, "error": f"That text is bigger than {limit_kb} KB, so nothing was written."}

        relative_name = target.relative_to(root_dir).as_posix()
        existed = target.exists()
        if existed and not overwrite:
            return {
                "ok": False,
                "error": (
                    "That file already exists in the workspace. Call write_file again "
                    "with overwrite=true to replace it."
                ),
            }

        missing_folders = []
        parent = target.parent
        while parent != root_dir and root_dir in parent.parents:
            if not parent.exists():
                missing_folders.append(parent)
            parent = parent.parent

        created_folders = []
        for folder in reversed(missing_folders):
            try:
                folder.mkdir()
            except FileExistsError:
                continue
            except OSError:
                self._remove_created_folders(created_folders)
                return {"ok": False, "error": "That file's folder could not be created inside the workspace."}
            created_folders.append(folder)

        try:
            if existed:
                handle, temp_name = tempfile.mkstemp(prefix=".write-", dir=str(target.parent))
                temp_path = Path(temp_name)
                try:
                    with os.fdopen(handle, "wb") as stream:
                        stream.write(data)
                    os.replace(temp_path, target)
                finally:
                    if temp_path.exists():
                        temp_path.unlink()
            else:
                handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                try:
                    os.write(handle, data)
                except BaseException:
                    os.close(handle)
                    try:
                        target.unlink()
                    except OSError:
                        pass
                    raise
                os.close(handle)
        except FileExistsError:
            self._remove_created_folders(created_folders)
            return {
                "ok": False,
                "error": (
                    "That file appeared while I was writing it. Call write_file again "
                    "with overwrite=true to replace it."
                ),
            }
        except OSError:
            self._remove_created_folders(created_folders)
            return {"ok": False, "error": "That file could not be written."}
        except Exception:
            self._remove_created_folders(created_folders)
            return {"ok": False, "error": "That file could not be written."}

        action = "overwritten" if existed else "created"
        return {
            "ok": True,
            "path": relative_name,
            "bytes": len(data),
            "characters": len(content),
            "created": not existed,
            "overwritten": existed,
            "summary": f"{action} {relative_name} ({len(data)} bytes)",
        }

    def _remove_created_folders(self, folders):
        for folder in reversed(folders or []):
            try:
                folder.rmdir()
            except OSError:
                pass
