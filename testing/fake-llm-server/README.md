# Fake LLM Server

A simple server that mimics the OpenAI streaming chat completions API for testing purposes.

## Features

- Implements a basic version of the OpenAI chat completions API
- Supports both streaming and non-streaming responses
- Always responds with "hello world" message
- Simulates a 429 rate limit error when the last message is "[429]"
- Configurable through environment variables

## Installation

```bash
npm install
```

## Usage

Start the server:

```bash
# Development mode
npm run dev

# Production mode
npm run build
npm start
```

### Example usage

```
curl -X POST http://localhost:3500/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Say something"}],"model":"any-model","stream":true}'
```

The server will be available at http://localhost:3500 by default.

## API Endpoints

### POST /v1/chat/completions

This endpoint mimics OpenAI's chat completions API.

#### Request Format

```json
{
  "messages": [{ "role": "user", "content": "Your prompt here" }],
  "model": "any-model",
  "stream": true
}
```

- Set `stream: true` to receive a streaming response
- Set `stream: false` or omit it for a regular JSON response

#### Response

For non-streaming requests, you'll get a standard JSON response:

```json
{
  "id": "chatcmpl-123456789",
  "object": "chat.completion",
  "created": 1699000000,
  "model": "fake-model",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "hello world"
      },
      "finish_reason": "stop"
    }
  ]
}
```

For streaming requests, you'll receive a series of server-sent events (SSE), each containing a chunk of the response.

### Simulating Rate Limit Errors

To test how your application handles rate limiting, send a message with content exactly equal to `[429]`:

```json
{
  "messages": [{ "role": "user", "content": "[429]" }],
  "model": "any-model"
}
```

This will return a 429 status code with the following response:

```json
{
  "error": {
    "message": "Too many requests. Please try again later.",
    "type": "rate_limit_error",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}
```

### Streaming Stress Content

To generate a large multi-file response on the fly (for stress testing the
streaming pipeline and renderer without committing a huge fixture), include both
the `[stress-files=N]` and `[stress-lines=M]` markers in the user message. N is
the number of files, M the line count per file.

```json
{
  "messages": [
    { "role": "user", "content": "[stress-files=300] [stress-lines=500]" }
  ],
  "model": "any-model"
}
```

The server emits N `<dyad-write>` blocks of M lines, streamed in the same SSE
format and at the same rate (~3200 chars/s) as any other response, so the load
mimics a fast-but-real provider. See `e2e-tests/stress_streaming.manual.ts` for
the local-only test that drives it (run with `STRESS_TEST=1 npx playwright
test`; override scale with `STRESS_FILES` / `STRESS_LINES` env vars).

## Configuration

You can configure the server by modifying the `PORT` variable in the code.

## Use Case

This server is primarily intended for testing applications that integrate with OpenAI's API, allowing you to develop and test without making actual API calls to OpenAI.
