"""Real pinned CronJobManager + SQLite persistence + MioBot loopback bridge.

All stores, the root, database and HTTP receiver are temporary fixtures. No
model, account, external channel, production database or user history is read.
"""
import atexit
import asyncio
from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
isolated = tempfile.TemporaryDirectory(prefix="miobot-workflows-native-")
atexit.register(isolated.cleanup)
os.environ["ASTRBOT_ROOT"] = isolated.name
os.environ["MIOBOT_MANAGED_WORKFLOWS"] = "1"
os.chdir(isolated.name)
sys.path.insert(0, str(ROOT / ".runtime/astrbot-source"))

from aiohttp import web
from quart import Quart
from astrbot.core.cron.manager import CronJobManager
from astrbot.core.db.sqlite import SQLiteDatabase
from astrbot.core.provider.register import llm_tools

spec = importlib.util.spec_from_file_location("miobot_workflows_native_fixture", ROOT / "integrations/plugins/astrbot_plugin_miobot_workflows/main.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class NativeWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="case-", dir=isolated.name)
        self.db_path = str(Path(self.temp.name) / "cron.sqlite")
        self.databases = []
        self.managers = []
        self.calls = []
        self.received = asyncio.Event()
        self.http_failure = False

        async def receive(request):
            self.assertEqual(request.path, "/internal/workflows/trigger")
            self.assertEqual(request.headers.get("X-MioBot-Tool-Token"), "fixture-secret-" * 3)
            self.calls.append(await request.json())
            self.received.set()
            if self.http_failure:
                return web.json_response({"ok": False}, status=503)
            return web.json_response({"ok": True, "queued": True})

        app = web.Application()
        app.router.add_post("/internal/workflows/trigger", receive)
        self.receiver = web.AppRunner(app)
        await self.receiver.setup()
        site = web.TCPSite(self.receiver, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        os.environ["MIOBOT_TOOL_URL"] = self.base
        os.environ["MIOBOT_TOOL_TOKEN"] = "fixture-secret-" * 3
        self.app = Quart(__name__)
        self.manager, self.plugin, self.db = await self.new_manager()

    async def new_manager(self):
        db = SQLiteDatabase(self.db_path)
        await db.initialize()
        manager = CronJobManager(db)
        apis = []
        context = SimpleNamespace(cron_manager=manager, register_web_api=lambda *args: apis.append(args))
        plugin = module.MioBotWorkflows(context)
        await manager.start(context)
        self.databases.append(db)
        self.managers.append(manager)
        self.assertEqual(apis[0][0], "/astrbot_plugin_miobot_workflows/sync")
        return manager, plugin, db

    async def sync(self, jobs, plugin=None, namespace="fixture-instance"):
        async with self.app.test_request_context("/sync", method="POST", json={"namespace": namespace, "jobs": jobs}):
            return await (plugin or self.plugin).sync()

    async def asyncTearDown(self):
        for manager in self.managers:
            await manager.shutdown()
        for db in self.databases:
            await db.engine.dispose()
        await self.receiver.cleanup()
        self.temp.cleanup()
        os.environ.pop("MIOBOT_TOOL_URL", None)
        os.environ.pop("MIOBOT_TOOL_TOKEN", None)

    async def test_real_one_shot_survives_restart_reattaches_handler_and_fires_once_to_local_http(self):
        at = (datetime.now(timezone.utc) + timedelta(seconds=2)).isoformat()
        job = {"id": "one-shot-fixture", "revision": 1, "active": True,
               "schedule": {"type": "once", "runAt": at, "timezone": "Asia/Shanghai"}}
        initial = await self.sync([job])
        self.assertEqual(initial["status"], "ok", initial)
        native_id = initial["data"]["jobs"][0]["nativeId"]
        row = await self.db.get_cron_job(native_id)
        self.assertTrue(row.persistent)
        self.assertTrue(row.run_once)
        self.assertEqual(row.payload["run_at"], at)
        await self.manager.shutdown()
        restored_manager, restored_plugin, restored_db = await self.new_manager()
        self.assertNotIn(native_id, restored_manager._basic_handlers)
        self.assertIsNone(restored_manager.scheduler.get_job(native_id))
        restored = await self.sync([job], plugin=restored_plugin)
        self.assertEqual(restored["data"]["jobs"][0]["nativeId"], native_id)
        self.assertIn(native_id, restored_manager._basic_handlers)
        self.assertIsNotNone(restored_manager.scheduler.get_job(native_id))
        await asyncio.wait_for(self.received.wait(), timeout=6)
        for _ in range(30):
            if await restored_db.get_cron_job(native_id) is None:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(self.calls, [{"workflowId": job["id"], "revision": 1, "scheduledAt": at}])
        self.assertIsNone(await restored_db.get_cron_job(native_id))
        self.assertIsNone(restored_manager.scheduler.get_job(native_id))

    async def test_daily_job_uses_real_cron_trigger_and_actual_handler_writes_a_receipt(self):
        job = {"id": "daily-fixture", "revision": 1, "active": True,
               "schedule": {"type": "daily", "time": "08:15", "timezone": "Asia/Shanghai"}}
        result = await self.sync([job])
        native_id = result["data"]["jobs"][0]["nativeId"]
        at = self.manager.get_next_run_time(native_id)
        self.assertEqual((at + timedelta(hours=8)).strftime("%H:%M"), "08:15")
        # Manual native-manager invocation exercises the same stored callback,
        # without pretending that tomorrow's wall-clock occurrence already ran.
        await self.manager.run_job_now(native_id)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["workflowId"], "daily-fixture")
        fired = datetime.fromisoformat(self.calls[0]["scheduledAt"])
        self.assertEqual((fired.second, fired.microsecond), (0, 0))
        row = await self.db.get_cron_job(native_id)
        self.assertEqual(row.status, "completed")
        self.assertIsNotNone(row.last_run_at)
        self.assertIsNotNone(self.manager.scheduler.get_job(native_id))

    async def test_weekly_sunday_pause_and_namespace_removal_use_one_native_scheduler(self):
        weekly = {"id": "sunday-fixture", "revision": 1, "active": True,
                  "schedule": {"type": "weekly", "time": "08:30", "weekdays": [7], "timezone": "Asia/Shanghai"}}
        result = await self.sync([weekly])
        native_id = result["data"]["jobs"][0]["nativeId"]
        next_at = self.manager.get_next_run_time(native_id) + timedelta(hours=8)
        self.assertEqual(next_at.isoweekday(), 7)
        self.assertEqual(next_at.strftime("%H:%M"), "08:30")
        foreign = await self.manager.add_basic_job(name="unrelated-fixture", cron_expression="0 9 * * *", handler=lambda: None, payload={"miobot_namespace": "other-instance", "workflow_id": "keep-me"}, enabled=False, persistent=True)
        paused = await self.sync([{**weekly, "active": False}])
        self.assertFalse(paused["data"]["jobs"][0]["enabled"])
        self.assertIsNone(self.manager.scheduler.get_job(native_id))
        await self.sync([])
        self.assertIsNone(await self.db.get_cron_job(native_id))
        self.assertIsNotNone(await self.db.get_cron_job(foreign.job_id))
        self.assertEqual(self.calls, [])

    async def test_missed_one_shot_is_not_replayed_after_restart(self):
        job = {"id": "missed-fixture", "revision": 1, "active": True,
               "schedule": {"type": "once", "runAt": (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat(), "timezone": "Asia/Shanghai"}}
        result = await self.sync([job])
        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["data"]["jobs"][0]["enabled"])
        self.assertIsNone(self.manager.get_next_run_time(result["data"]["jobs"][0]["nativeId"]))
        self.assertEqual(self.calls, [])

    async def test_invalid_plan_does_not_mutate_database_and_http_failure_is_a_failed_native_receipt(self):
        bad = {"id": "bad-fixture", "revision": 1, "active": True,
               "schedule": {"type": "weekly", "time": "08:00", "weekdays": [0], "timezone": "Asia/Shanghai"}}
        result = await self.sync([bad])
        self.assertEqual(result["status"], "error")
        self.assertEqual(await self.manager.list_jobs("basic"), [])
        good = {"id": "failing-fixture", "revision": 1, "active": True,
                "schedule": {"type": "daily", "time": "08:00", "timezone": "Asia/Shanghai"}}
        created = await self.sync([good])
        native_id = created["data"]["jobs"][0]["nativeId"]
        self.http_failure = True
        await self.manager.run_job_now(native_id)
        row = await self.db.get_cron_job(native_id)
        self.assertEqual(row.status, "failed")
        self.assertIn("host did not accept", row.last_error)

    async def test_bridge_refuses_non_loopback_destination_and_short_token_before_network(self):
        for url, token in [("https://example.invalid", "fixture-secret-" * 3), (self.base, "short")]:
            os.environ["MIOBOT_TOOL_URL"] = url
            os.environ["MIOBOT_TOOL_TOKEN"] = token
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                await self.plugin._post("/internal/workflows/trigger", {})
        self.assertEqual(self.calls, [])

    async def test_actual_registered_tools_do_not_expose_owner_recipient_or_execution_permissions(self):
        expected = {"miobot_schedule_workflow": {"title", "instruction", "schedule_json"},
                    "miobot_list_workflows": set(), "miobot_cancel_workflow": {"workflow_id"}}
        for name, fields in expected.items():
            tool = llm_tools.get_func(name)
            self.assertIsNotNone(tool, name)
            self.assertEqual(set(tool.parameters["properties"]), fields)


if __name__ == "__main__":
    unittest.main(verbosity=2)
