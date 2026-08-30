#!/usr/bin/env python3
"""Deterministic loopback OpenAI-compatible server for Hermes lifecycle tests."""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class Handler(BaseHTTPRequestHandler):
    server_version = "ValKhanaCanary/1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_stream(self, messages: list[dict[str, Any]]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for message in messages:
            event = {
                "id": "chatcmpl-valkhana-canary",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": "valkhana-canary-model",
                "choices": [message],
            }
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path.rstrip("/") == "/v1/models":
            self.send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "valkhana-canary-model",
                            "object": "model",
                            "owned_by": "valkhana-canary",
                        }
                    ],
                },
            )
            return
        self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path.rstrip("/") != "/v1/chat/completions":
            self.send_json(404, {"error": {"message": "not found"}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1024 * 1024:
                raise ValueError("request too large")
            request = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": {"message": "invalid request"}})
            return

        messages = request.get("messages", [])
        saw_tool_result = any(message.get("role") == "tool" for message in messages)
        offered_tools = {
            tool.get("function", {}).get("name") for tool in request.get("tools", [])
        }
        if saw_tool_result:
            message = {"role": "assistant", "content": "ValKhana canary completed."}
            finish_reason = "stop"
        elif "kanban_complete" not in offered_tools:
            message = {"role": "assistant", "content": "ValKhana canary task"}
            finish_reason = "stop"
        else:
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_valkhana_canary_complete",
                        "type": "function",
                        "function": {
                            "name": "kanban_complete",
                            "arguments": json.dumps(
                                {
                                    "summary": "ValKhana deterministic worker canary passed",
                                    "metadata": {
                                        "canary": True,
                                        "provider": "loopback-mock",
                                    },
                                }
                            ),
                        },
                    }
                ],
            }
            finish_reason = "tool_calls"

        if request.get("stream"):
            if "tool_calls" in message:
                self.send_stream(
                    [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": message["tool_calls"],
                            },
                            "finish_reason": None,
                        },
                        {"index": 0, "delta": {}, "finish_reason": finish_reason},
                    ]
                )
            else:
                self.send_stream(
                    [
                        {
                            "index": 0,
                            "delta": {"role": "assistant", "content": message["content"]},
                            "finish_reason": None,
                        },
                        {"index": 0, "delta": {}, "finish_reason": finish_reason},
                    ]
                )
            return

        self.send_json(
            200,
            {
                "id": "chatcmpl-valkhana-canary",
                "object": "chat.completion",
                "created": 0,
                "model": "valkhana-canary-model",
                "choices": [
                    {
                        "index": 0,
                        "message": message,
                        "finish_reason": finish_reason,
                    }
                ],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
            },
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18765)
    arguments = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", arguments.port), Handler)
    print(f"ready=http://127.0.0.1:{arguments.port}/v1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
