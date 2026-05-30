from __future__ import annotations

import base64
import sys
import types

import pytest

if "tiktoken" not in sys.modules:
    fake_tiktoken = types.SimpleNamespace(
        encoding_for_model=lambda _model: types.SimpleNamespace(encode=lambda value: list(str(value))),
        get_encoding=lambda _name: types.SimpleNamespace(encode=lambda value: list(str(value))),
    )
    sys.modules["tiktoken"] = fake_tiktoken

try:
    from services.protocol.conversation import message_text, normalize_messages
except ModuleNotFoundError as exc:  # pragma: no cover - local minimal env may omit optional app deps
    pytest.skip(f"missing optional test dependency: {exc.name}", allow_module_level=True)


def test_normalize_messages_keeps_image_message_once(monkeypatch):
    monkeypatch.setattr("services.protocol.conversation.config.global_system_prompt", "")
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "describe"},
                {"type": "image", "data": b"image-bytes", "mime": "image/png"},
            ],
        }
    ]

    normalized = normalize_messages(messages)

    assert len(normalized) == 1
    assert normalized[0]["role"] == "user"
    assert normalized[0]["content"][0] == {"type": "text", "text": "describe"}
    assert normalized[0]["content"][1] == {"type": "image", "data": b"image-bytes", "mime": "image/png"}


def test_message_text_reads_chat_completion_file_data():
    encoded = base64.b64encode("hello from an attached file".encode()).decode()

    text = message_text([
        {"type": "text", "text": "please summarize"},
        {
            "type": "file",
            "file": {
                "filename": "note.txt",
                "file_data": f"data:text/plain;base64,{encoded}",
            },
        },
    ])

    assert "please summarize" in text
    assert "[Attached file: note.txt]" in text
    assert "hello from an attached file" in text


def test_message_text_keeps_file_id_reference():
    text = message_text([
        {"type": "file", "file": {"file_id": "file_abc123", "filename": "report.pdf"}},
    ])

    assert "file_abc123" in text
    assert "report.pdf" in text
