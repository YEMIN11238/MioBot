"""Fixed public Bilibili catalog, bounded anonymous downloads and authorization."""

import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.request
import warnings

from PIL import Image


PACK_ID = "bilibili-basic-tv"
SOURCE_API = "https://api.bilibili.com/x/emote/package?business=reply&ids=2"
MAX_JSON = 1024 * 1024
MAX_IMAGE = 2 * 1024 * 1024
MAX_TOTAL = 10 * 1024 * 1024
MAX_IMAGES = 12
MAX_PACK_IMAGES = 200
TIMEOUT = 10
MAX_RUN_SECONDS = 75
CATALOG = json.loads((Path(__file__).parent / "catalog.json").read_text())["items"]
BY_ID = {row["id"]: row for row in CATALOG}
ALIASES = {"doge": 34, **{r["name"][4:-1]: r["id"] for r in CATALOG}}
ALIASES.update({r["name"]: r["id"] for r in CATALOG})


class CollectorError(ValueError):
    """A source, payload or installed asset was not accepted."""


def validate_image_url(url):
    if not isinstance(url, str) or re.fullmatch(
        r"https://i[012]\.hdslb\.com/bfs/emote/[0-9a-f]{40}\.png", url
    ) is None:
        raise CollectorError("图片来源不在固定官方 CDN 范围内")
    return url


def verify_png(data):
    if not isinstance(data, bytes) or not data or len(data) > MAX_IMAGE:
        raise CollectorError("图片为空或超过 2 MB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "PNG" or getattr(image, "n_frames", 1) != 1:
                    raise CollectorError("基础表情只接受静态 PNG")
                width, height = image.size
                if not 1 <= width <= 2048 or not 1 <= height <= 2048:
                    raise CollectorError("图片尺寸超出范围")
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
    except CollectorError:
        raise
    except Exception as exc:
        raise CollectorError("图片解码校验失败") from exc
    return {"width": width, "height": height, "sha256": hashlib.sha256(data).hexdigest()}


def _direct_text(event):
    try:
        parts = event.get_messages()
        # Referenced/forwarded contents are never traversed. A new top-level
        # Plain command from the real owner remains a current instruction.
        texts = [p.text.strip() for p in parts if type(p).__name__ == "Plain" and p.text.strip()]
        return texts[0] if len(texts) == 1 else ""
    except Exception:
        return ""


def is_owner_event(event, config):
    owner, umo = config.get("owner_qq", ""), config.get("owner_umo", "")
    if not isinstance(owner, str) or not re.fullmatch(r"[0-9]+", owner):
        return False
    if not isinstance(umo, str) or re.fullmatch(r"[^:\s]+:FriendMessage:" + owner, umo) is None:
        return False
    try:
        return bool(
            event.is_private_chat()
            and event.get_platform_name() == "aiocqhttp"
            and event.get_platform_id() == umo.split(":", 1)[0]
            and event.unified_msg_origin == umo
            and str(event.get_sender_id()) == owner
            and type(event).__name__ != "CronMessageEvent"
            and event.get_extra("cron_job") is None
            and event.get_extra("cron_payload") is None
            and _direct_text(event)
        )
    except Exception:
        return False


def _plain_request(event):
    text = _direct_text(event)
    if any(c in text for c in "?？\"'`“”‘’「」『』"):
        return ""
    return text.strip(" \t，,。.!！")


def is_collect_request(event):
    text = _plain_request(event)
    if text.startswith("/"):
        text = text[1:]
    return text in {
        "收B站表情", "收集B站表情", "帮我收B站表情", "给我收B站表情",
        "去B站收表情", "从B站收表情", "去B站收点表情", "帮我去B站收表情",
        "收B站基础表情", "收B站小电视表情", "从B站收小电视表情",
        "去B站收小电视表情", "帮我收B站基础表情", "收B站表情包",
        "去B站收表情包", "从B站收表情包", "帮我收B站表情包",
        "帮我从B站收表情", "帮我从B站收表情包",
    }


def canonical_name(name):
    if not isinstance(name, str):
        raise CollectorError("仅支持固定小电视表情名称")
    key = name.strip()
    if key.casefold() == "doge":
        key = "doge"
    if key not in ALIASES:
        raise CollectorError("仅支持 doge、白眼、坏笑、生气、疑问、大哭、笑哭、点赞、睡着、偷笑、可爱")
    return BY_ID[ALIASES[key]]


def requested_send(event):
    text = _plain_request(event)
    if text.startswith("/"):
        text = text[1:]
    if text == "B站表情":
        return BY_ID[34]
    if text.startswith("B站表情 "):
        return canonical_name(text[len("B站表情 "):])
    for prefix in ("发个B站", "发一个B站", "给我发个B站", "给我发一个B站", "发B站", "来个B站"):
        if text.startswith(prefix):
            name = text[len(prefix):]
            if name.endswith("表情"):
                name = name[:-2]
            return canonical_name(name)
    return None


def select_metadata(payload):
    if not isinstance(payload, dict) or payload.get("code") != 0:
        raise CollectorError("官方基础包接口返回异常")
    packages = (payload.get("data") or {}).get("packages")
    if not isinstance(packages, list):
        raise CollectorError("官方基础包格式异常")
    packages = [p for p in packages if isinstance(p, dict) and p.get("id") == 2]
    if len(packages) != 1 or not isinstance(packages[0].get("emote"), list):
        raise CollectorError("未找到唯一的小电视基础包")
    result, seen = [], set()
    for row in packages[0]["emote"]:
        if not isinstance(row, dict) or type(row.get("id")) is not int or row["id"] not in BY_ID:
            continue
        expected = BY_ID[row["id"]]
        if row["id"] in seen or row.get("text") != expected["name"]:
            raise CollectorError("固定表情标签或 ID 重复，等待核对来源")
        url = validate_image_url(row.get("url"))
        if url.rsplit("/", 1)[-1] != expected["url"].rsplit("/", 1)[-1]:
            raise CollectorError("固定表情资源发生变化，等待核对来源")
        seen.add(row["id"])
        result.append({**expected, "url": url})
    if len(result) > MAX_IMAGES:
        raise CollectorError("单次表情数量超过限制")
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CollectorError("不接受图片或接口重定向")


class DownloadBudget:
    def __init__(self, deadline=None):
        self.remaining = MAX_TOTAL
        self.lock = threading.Lock()
        self.deadline = deadline

    def read(self, response, maximum):
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise CollectorError("本轮下载已达时间上限")
        with self.lock:
            amount = min(maximum, self.remaining)
            if amount <= 0:
                raise CollectorError("本轮图片下载已达 10 MB 上限")
            self.remaining -= amount
        try:
            reader = getattr(response, "read1", response.read)
            chunk = reader(amount)
        except BaseException:
            with self.lock:
                self.remaining += amount
            raise
        with self.lock:
            self.remaining += amount - len(chunk)
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise CollectorError("本轮下载已达时间上限")
        return chunk


def fetch_limited(url, limit, *, budget=None, deadline=None):
    if url != SOURCE_API:
        validate_image_url(url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    req = urllib.request.Request(url, headers={"User-Agent": "dafeiyu-basic-stickers/0.1", "Accept-Encoding": "identity"})
    remaining = TIMEOUT if deadline is None else min(TIMEOUT, deadline - time.monotonic())
    if remaining <= 0:
        raise CollectorError("本轮下载已达时间上限")
    with opener.open(req, timeout=remaining) as response:
        if response.geturl() != url or response.status != 200:
            raise CollectorError("官方资源响应地址或状态异常")
        size = response.headers.get("Content-Length")
        if size and (not size.isdigit() or int(size) > limit):
            raise CollectorError("官方资源体积超出限制")
        data = bytearray()
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                raise CollectorError("本轮下载已达时间上限")
            amount = min(65536, limit + 1 - len(data))
            reader = getattr(response, "read1", response.read)
            chunk = budget.read(response, amount) if budget is not None else reader(amount)
            if deadline is not None and time.monotonic() >= deadline:
                raise CollectorError("本轮下载已达时间上限")
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > limit:
                raise CollectorError("下载资源超过体积限制")
            if size and len(data) == int(size):
                break
        if size and len(data) != int(size):
            raise CollectorError("官方资源下载不完整")
        return bytes(data)


def download_selected():
    deadline = time.monotonic() + MAX_RUN_SECONDS
    try:
        metadata = json.loads(fetch_limited(SOURCE_API, MAX_JSON, deadline=deadline))
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise CollectorError("官方接口不是有效 JSON") from exc
    selected = select_metadata(metadata)
    budget = DownloadBudget(deadline)

    def download(row):
        try:
            data = fetch_limited(row["url"], MAX_IMAGE, budget=budget, deadline=deadline)
            detail = verify_png(data)
            if detail["sha256"] != row["sha256"]:
                raise CollectorError("表情内容与已核验基础素材不同")
            return {**row, "content": data}, None
        except Exception:
            return None, row["id"]

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(download, selected))
    images = [image for image, error in outcomes if image is not None]
    missing = sorted(set(BY_ID) - {row["id"] for row in selected})
    failed = missing + [error for image, error in outcomes if error is not None]
    return {"images": images, "failed_ids": failed, "downloaded_bytes": MAX_TOTAL - budget.remaining}
