# Python AI Agent

This is a small educational project for learning how a Python AI app can talk to an OpenAI-compatible API.

## 1. Install

```bash
pip install -r requirements.txt
```

## 2. Configure the environment

Create or update the `.env` file in the project root and add your real provider keys:

```env
OPENAI_API_KEY=your_key_here
BASE_URL=https://api.openai.com/v1
MODEL_ID=gpt-4o-mini
```

The app reads this file automatically.

## 3. Run the app

```bash
python app.py
```

Then open http://127.0.0.1:8000 in your browser.

## 4. How the chat works

The browser sends the newest user message and the recent conversation history to the backend.

The backend:

- builds the message list,
- sends it to the model,
- handles tool calls when the model asks for them,
- reads actual provider token usage from the response,
- compacts the conversation when actual input usage reaches 4000 tokens.

## 5. The two tools

The app defines exactly two tools directly in `app.py`:

- `write_file`: allows the model to write a file inside the project workspace.
- `web_search`: performs a simple web search and returns a few results.

The model can choose one or both tools during a turn. The backend executes them and sends the results back to the model.

## 6. Actual token usage

The app only uses provider-reported token numbers. It does not estimate tokens.

When the provider returns usage data, the app keeps:

- actual input tokens,
- actual output tokens,
- actual total tokens,
- cached tokens, if available,
- reasoning tokens, if available.

If a provider value is missing, the UI shows `N/A` instead of guessing a zero.

## 7. Compaction

After a completed model response, the app checks actual input tokens.

- If the value is below 4000, nothing happens.
- If the value is 4000 or more, the app creates a short summary.
- The summary is stored with the conversation and reused on the next request.
- The browser keeps the full conversation locally and continues to send its history through the existing API; the backend applies its existing recent-history limit while also receiving the saved summary.

The compaction logic is intentionally simple and based only on actual provider input usage.

## 8. Where conversation data is stored

The browser stores the chat data in localStorage. The stored data includes:

- conversation messages,
- summary text,
- compaction count,
- actual usage information.

The interface also supports multiple conversations, conversation search, rename and delete actions, and six selectable visual themes. Existing conversations saved under the earlier `tokenharbor.chat.v1` browser-storage key are read and merged into the current conversation list; the old key is not removed.

## 9. Frontend notes

The page uses the existing `/api/chat` endpoint and does not make extra backend requests for theme, conversation, or analytics interactions. The usage panel shows provider-reported values from completed responses. A missing provider value is displayed as `N/A`.

The interface is responsive: conversation navigation and usage insights open as mobile drawers. Its animated glass-like AI emblem is drawn with CSS, so the project does not need a 3D rendering package.
