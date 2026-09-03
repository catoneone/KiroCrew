"""Rotated-archive pagination: the corpus behind `before`/`next_before` cursors.

A size rotation moves a transcript's HEAD into ``sessions/archive/`` — and the
plain chained read never looks there, so pagination used to declare the
transcript complete at the rotation boundary: the reader's oldest messages
became permanently unreachable from the UI (observed live: a session's true
first message sat in ``archive/…__20260901-043212.jsonl`` while "load previous"
retired at a mid-conversation row).

``read_messages_chained_full`` is the fix's foundation: per chain key, the
rotate-archived head followed by the surviving file. These tests pin:

- the full read restores the pre-rotation timeline, oldest first;
- non-rotate archive segments (``compact`` — content the product DISCARDED)
  never resurface;
- the per-key cache invalidates when a new rotation lands.
"""

from __future__ import annotations

import json

import pytest

from kiro_crew.history import ConversationLog


def _contents(msgs: list[dict]) -> list[str]:
    return [m.get("content", "") for m in msgs]


@pytest.fixture()
def rotated_log(tmp_path, monkeypatch):
    """A log whose session 't1' rotated at least once, with 20 known messages."""
    monkeypatch.setattr("kiro_crew.history._SESSION_MAX_BYTES", 400)
    monkeypatch.setattr("kiro_crew.history._SESSION_KEEP_LINES", 3)
    log = ConversationLog(base_dir=tmp_path)
    for i in range(20):
        log.append("t1", "user", f"message number {i:02d} with enough text to exceed limits")
    archives = list((tmp_path / "archive").glob("t1__*.jsonl"))
    assert archives, "fixture must rotate"
    return log, tmp_path


class TestReadMessagesChainedFull:
    def test_restores_pre_rotation_timeline(self, rotated_log):
        log, tmp_path = rotated_log
        plain = log.read_messages_chained("t1")
        full = log.read_messages_chained_full("t1")
        # The plain read lost the rotated head; the full read has every message
        # in send order.
        assert len(plain) < 20
        assert _contents(full) == [
            f"message number {i:02d} with enough text to exceed limits" for i in range(20)
        ]

    def test_compact_segments_do_not_resurface(self, tmp_path):
        log = ConversationLog(base_dir=tmp_path)
        log.append("t2", "user", "kept message")
        log.rewrite_session("t2", [{"role": "user", "content": "kept message", "ts": "x"}])
        # rewrite_session archives what it drops under reason="compact"; craft
        # one explicitly to make the exclusion unmistakable.
        adir = tmp_path / "archive"
        adir.mkdir(exist_ok=True)
        seg = adir / "t2__20990101-000000.jsonl"
        seg.write_text(
            json.dumps({"_type": "archive", "reason": "compact", "count": 1})
            + "\n"
            + json.dumps({"role": "user", "content": "discarded by rewind"})
            + "\n",
            encoding="utf-8",
        )
        full = log.read_messages_chained_full("t2")
        assert "discarded by rewind" not in _contents(full)
        assert "kept message" in _contents(full)

    def test_cache_invalidates_on_new_rotation(self, rotated_log, monkeypatch):
        log, tmp_path = rotated_log
        first = log.read_messages_chained_full("t1")
        # Append enough to rotate again; the full read must pick up the new
        # segment rather than serve the cached rows.
        for i in range(20, 30):
            log.append("t1", "user", f"message number {i:02d} with enough text to exceed limits")
        second = log.read_messages_chained_full("t1")
        assert len(second) > len(first)
        assert _contents(second)[0].startswith("message number 00")
        assert _contents(second)[-1].startswith("message number 29")

    def test_rotated_chain_read_returns_only_archived_head(self, rotated_log):
        log, tmp_path = rotated_log
        rotated = log.read_rotated_messages_chained("t1")
        plain = log.read_messages_chained("t1")
        assert len(rotated) + len(plain) == 20
        # Oldest first, and strictly the head the rotation removed.
        assert _contents(rotated) == [
            f"message number {i:02d} with enough text to exceed limits" for i in range(len(rotated))
        ]

    def test_no_archive_is_identity(self, tmp_path):
        log = ConversationLog(base_dir=tmp_path)
        log.append("t3", "user", "only message")
        assert _contents(log.read_messages_chained_full("t3")) == ["only message"]
        assert log.read_rotated_messages_chained("t3") == []
