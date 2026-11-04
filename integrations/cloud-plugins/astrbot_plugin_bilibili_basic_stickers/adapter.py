"""Version-pinned in-process reuse of meme_manager's storage and file locks."""

import copy
import hashlib
import importlib
import json
from pathlib import Path
import tempfile
import zipfile

from . import core


def merge_owner_rule(rules, owner_umo, fallback_pack_ids):
    if not isinstance(rules, list) or not rules or not owner_umo:
        raise core.CollectorError("原生选包规则缺失，未改动任何默认规则")
    result = copy.deepcopy(rules)
    matches = [r for r in result if r.get("scope") == "session" and r.get("target") == owner_umo]
    if len(matches) > 1:
        raise core.CollectorError("主人会话选包规则重复，需先处理冲突")
    if matches:
        rule = matches[0]
        old = rule.get("pack_ids") or [rule.get("pack_id")]
    else:
        old = list(fallback_pack_ids)
        existing_ids = {r.get("id") for r in result}
        identifier = "bilibili-basic-owner"
        while identifier in existing_ids:
            identifier += "-tv"
        rule = {"id": identifier, "scope": "session", "target": owner_umo}
        result.insert(0, rule)
    if not isinstance(old, list) or not old or not all(isinstance(x, str) and x for x in old):
        raise core.CollectorError("无法保留主人现有图包顺序，未改选包规则")
    ids = list(old)
    if core.PACK_ID not in ids:
        ids.append(core.PACK_ID)
    rule["pack_id"], rule["pack_ids"] = ids[0], ids
    return result


def _safe_pack(packs_root):
    root = Path(packs_root).resolve()
    pack = root / core.PACK_ID
    if pack.is_symlink() or pack.resolve().parent != root:
        raise core.CollectorError("固定图包路径异常")
    if not pack.is_dir():
        raise FileNotFoundError(core.PACK_ID)
    manifest_path = pack / "manifest.json"
    if manifest_path.is_symlink() or manifest_path.stat().st_size > core.MAX_JSON:
        raise core.CollectorError("固定图包清单异常")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest.get("id") != core.PACK_ID or manifest.get("upstream_package_id") != 2:
        raise core.CollectorError("图包标识与已支持的小电视来源不一致")
    memes = pack / "memes"
    if memes.is_symlink() or not memes.is_dir() or memes.resolve().parent != pack:
        raise core.CollectorError("固定图包图片目录异常")
    return pack, manifest


def _pack_images(pack):
    files = []
    for category in (pack / "memes").iterdir():
        if category.is_symlink():
            raise core.CollectorError("图包不能包含符号链接")
        if not category.is_dir():
            continue
        for path in category.iterdir():
            if path.is_symlink() or path.is_dir():
                raise core.CollectorError("图包包含不支持的嵌套目录或链接")
            if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
                files.append(path)
                if len(files) > core.MAX_PACK_IMAGES:
                    raise core.CollectorError("固定图包已超过 200 张上限")
    return files


def resolve_fixed_image(packs_root, entry):
    if entry.get("id") not in core.BY_ID or entry != core.BY_ID[entry["id"]]:
        raise core.CollectorError("不接受目录或任意素材参数")
    pack, _ = _safe_pack(packs_root)
    paths = _pack_images(pack)
    expected = pack / entry["file"]
    candidates = [expected] + [p for p in paths if p.parent.name == entry["category"] and p != expected]
    for path in candidates:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > core.MAX_IMAGE:
            continue
        if path.resolve().parent != (pack / "memes" / entry["category"]).resolve():
            raise core.CollectorError("固定素材路径异常")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() == entry["sha256"]:
            core.verify_png(data)
            return path
    raise core.CollectorError("这张基础表情尚未安装或内容已变化，请先收B站表情")


class MemeAdapter:
    def __init__(self, mm, storage, images, packs_root):
        self.mm, self.storage, self.images = mm, storage, images
        self.packs_root = Path(packs_root).resolve()

    @classmethod
    def from_context(cls, context):
        metadata = context.get_registered_star("meme_manager")
        mm = getattr(metadata, "star_cls", None)
        version = str(getattr(metadata, "version", "")).lstrip("v")
        if mm is None or version != "5.2.10-owner-stickers.1":
            raise core.CollectorError("需要已启用且版本匹配的原生表情包管理器")
        for name in ("_run_guarded_runtime_file_operation", "_resolve_runtime_pack_context", "_invalidate_pack_semantics"):
            if not callable(getattr(mm, name, None)):
                raise core.CollectorError("表情包管理器接入接口不匹配")
        package = type(mm).__module__.rsplit(".", 1)[0]
        if package.rsplit(".", 1)[-1] not in {"meme_manager", "astrbot_plugin_meme_manager"}:
            raise core.CollectorError("无法确认原生表情包模块位置")
        storage = importlib.import_module(package + ".backend.packs.storage")
        images = importlib.import_module(package + ".backend.packs.images")
        config = importlib.import_module(package + ".config")
        return cls(mm, storage, images, config.PACKS_DIR)

    async def collect(self, downloaded, event, owner_umo):
        fallback = self.mm._resolve_runtime_pack_context(event=event)
        ids = fallback.get("pack_ids") or [fallback.get("pack_id")]
        return await self.mm._run_guarded_runtime_file_operation(
            "收集B站固定基础表情", self._commit, downloaded, owner_umo, ids
        )

    def _commit(self, downloaded, owner_umo, fallback_ids, operation_guard=None):
        images = downloaded["images"]
        if len(images) > core.MAX_IMAGES:
            raise core.CollectorError("单次图片数量超限")
        for item in images:
            expected = core.BY_ID.get(item.get("id"))
            detail = core.verify_png(item.get("content"))
            if expected is None or detail["sha256"] != expected["sha256"] or item.get("category") != expected["category"]:
                raise core.CollectorError("待导入素材与固定目录不一致")
        if sum(len(i["content"]) for i in images) > core.MAX_TOTAL:
            raise core.CollectorError("单次图片总量超限")
        if operation_guard:
            operation_guard(core.PACK_ID, "收集B站固定基础表情")
        rules_before = self.storage.get_selection_rules()["rules"]
        new_rules = merge_owner_rule(rules_before, owner_umo, fallback_ids)
        pack_path = self.packs_root / core.PACK_ID
        added = duplicate = conflict = 0
        if not pack_path.exists():
            if not images:
                raise core.CollectorError("没有下载到有效基础表情，未建立图包")
            with tempfile.TemporaryDirectory(prefix="bili-basic-pack-") as tmp:
                archive = Path(tmp) / "basic.zip"
                manifest = json.loads((Path(__file__).parent / "pack-manifest.json").read_text())
                with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as file:
                    file.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
                    for item in images:
                        file.writestr(core.BY_ID[item["id"]]["file"], item["content"])
                result = self.storage.import_pack_archive(
                    archive, overwrite=False, set_as_default=False,
                    preserve_existing_selection=True, expected_pack_id=core.PACK_ID,
                    operation_guard=operation_guard,
                )
                if result.get("pack_id") != core.PACK_ID:
                    raise core.CollectorError("原生导入结果不是固定图包")
            added = len(images)
        else:
            pack, manifest = _safe_pack(self.packs_root)
            count = len(_pack_images(pack))
            allowed_categories = manifest.get("categories", {})
            for item in images:
                expected = core.BY_ID[item["id"]]
                category = expected["category"]
                if category not in allowed_categories:
                    conflict += 1
                    continue
                try:
                    resolve_fixed_image(self.packs_root, expected)
                except core.CollectorError:
                    pass
                else:
                    duplicate += 1
                    continue
                if count >= core.MAX_PACK_IMAGES:
                    conflict += 1
                    continue
                try:
                    self.images.save_chat_upload_image(pack / "memes", category, item["content"])
                    added += 1
                    count += 1
                except self.images.DuplicateEmojiError:
                    duplicate += 1
                except (ValueError, OSError):
                    conflict += 1
            if added:
                self.mm._invalidate_pack_semantics(core.PACK_ID)
        result = {"ok": True, "pack_id": core.PACK_ID, "added": added,
                "duplicates": duplicate, "failed": len(downloaded["failed_ids"]) + conflict,
                "downloaded_bytes": downloaded["downloaded_bytes"]}
        if new_rules != rules_before:
            try:
                self.storage.save_selection_rules(new_rules)
            except (ValueError, OSError, RuntimeError):
                result.update(ok=False, reason="图片已处理，但主人选包规则未保存成功；请勿宣称已经全部接通。")
        return result

    def image_path(self, name):
        return resolve_fixed_image(self.packs_root, core.canonical_name(name))
