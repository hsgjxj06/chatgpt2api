import json
import unittest
from unittest import mock

from services.protocol import conversation
from services.protocol.conversation import ConversationRequest, stream_image_outputs
from services.register.mail_provider import CloudMailGenProvider


class ToolInvokedImageBackend:
    def __init__(self):
        self.resolve_calls = []

    def stream_conversation(self, **kwargs):
        yield json.dumps({
            "type": "server_ste_metadata",
            "conversation_id": "conv-1",
            "metadata": {"tool_invoked": True},
        })
        yield json.dumps({
            "v": {
                "message": {
                    "author": {"role": "assistant"},
                    "content": {"parts": ["Generating your image..."]},
                }
            }
        })
        yield "[DONE]"

    def resolve_conversation_image_urls(self, conversation_id, file_ids, sediment_ids):
        self.resolve_calls.append((conversation_id, file_ids, sediment_ids))
        return ["https://example.test/image.png"]

    def download_image_bytes(self, image_urls):
        assert image_urls == ["https://example.test/image.png"]
        return [b"fake-image"]


class TextOnlyImageBackend(ToolInvokedImageBackend):
    def stream_conversation(self, **kwargs):
        yield json.dumps({
            "conversation_id": "conv-2",
            "v": {
                "message": {
                    "author": {"role": "assistant"},
                    "content": {"parts": ["I cannot generate that image."]},
                }
            },
        })
        yield "[DONE]"


class PlanFixTests(unittest.TestCase):
    def test_stream_image_outputs_polls_when_tool_invoked_without_input_images(self):
        backend = ToolInvokedImageBackend()
        with mock.patch.object(conversation, "save_image_bytes", return_value="https://saved.test/image.png"):
            outputs = list(stream_image_outputs(backend, ConversationRequest(model="gpt-image-2", prompt="draw a cat")))

        self.assertEqual(backend.resolve_calls, [("conv-1", [], [])])
        self.assertEqual(outputs[-1].kind, "result")
        self.assertEqual(outputs[-1].data, [
            {
                "b64_json": "ZmFrZS1pbWFnZQ==",
                "url": "https://saved.test/image.png",
                "revised_prompt": "draw a cat",
            }
        ])

    def test_stream_image_outputs_returns_message_without_image_context(self):
        backend = TextOnlyImageBackend()

        outputs = list(stream_image_outputs(backend, ConversationRequest(model="gpt-image-2", prompt="draw a cat")))

        self.assertEqual(backend.resolve_calls, [])
        self.assertEqual(outputs[-1].kind, "message")
        self.assertEqual(outputs[-1].text, "I cannot generate that image.")

    def test_cloudmail_gen_uses_admin_email_domain_when_domain_is_empty(self):
        provider = CloudMailGenProvider(
            {
                "api_base": "https://mail.example.test",
                "admin_email": "admin@example.com",
                "admin_password": "secret",
                "domain": [],
            },
            {"request_timeout": 1, "user_agent": "unittest", "proxy": ""},
        )

        mailbox = provider.create_mailbox("alice")

        self.assertEqual(mailbox["address"], "alice@example.com")

    def test_cloudmail_gen_requires_configured_or_admin_email_domain(self):
        provider = CloudMailGenProvider(
            {
                "api_base": "https://mail.example.test",
                "admin_email": "admin",
                "admin_password": "secret",
                "domain": [],
            },
            {"request_timeout": 1, "user_agent": "unittest", "proxy": ""},
        )

        with self.assertRaisesRegex(RuntimeError, "CloudMailGen 需要至少配置一个 domain"):
            provider.create_mailbox("alice")


if __name__ == "__main__":
    unittest.main()
