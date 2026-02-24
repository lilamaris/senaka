<script lang="ts">
  import { onMount } from 'svelte';

  type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
  type ChatSession = { id: string; createdAt: string; updatedAt: string; messages: ChatMessage[] };
  type SessionRow = { id: string; updatedAt: string; messageCount: number };

  let sessions: SessionRow[] = [];
  let selectedSessionId = 'default';
  let selectedSession: ChatSession | null = null;
  let newSessionId = '';
  let userInput = '';
  let loading = false;
  let error = '';

  async function refreshSessions() {
    error = '';
    const res = await fetch('/api/sessions');
    if (!res.ok) {
      error = `failed to load sessions: ${await res.text()}`;
      return;
    }
    const body = (await res.json()) as { sessions: SessionRow[] };
    sessions = body.sessions;

    if (!sessions.find((s) => s.id === selectedSessionId) && sessions.length > 0) {
      selectedSessionId = sessions[0].id;
    }
  }

  async function loadSession(id: string) {
    loading = true;
    error = '';
    selectedSessionId = id;

    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) {
      error = `failed to load session: ${await res.text()}`;
      loading = false;
      return;
    }

    const body = (await res.json()) as { session: ChatSession };
    selectedSession = body.session;
    loading = false;
  }

  async function createOrSelectSession() {
    const id = (newSessionId || selectedSessionId || 'default').trim();
    if (!id) return;

    await loadSession(id);
    await refreshSessions();
    newSessionId = '';
  }

  async function sendTurn() {
    if (!userInput.trim()) return;
    if (!selectedSessionId.trim()) return;

    loading = true;
    error = '';

    const res = await fetch(`/api/sessions/${selectedSessionId}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: userInput })
    });

    if (!res.ok) {
      error = `turn failed: ${await res.text()}`;
      loading = false;
      return;
    }

    const body = (await res.json()) as { session: ChatSession };
    selectedSession = body.session;
    userInput = '';
    loading = false;
    await refreshSessions();
  }

  async function resetCurrentSession() {
    if (!selectedSessionId) return;

    loading = true;
    error = '';
    const res = await fetch(`/api/sessions/${selectedSessionId}`, { method: 'DELETE' });

    if (!res.ok) {
      error = `reset failed: ${await res.text()}`;
      loading = false;
      return;
    }

    const body = (await res.json()) as { session: ChatSession };
    selectedSession = body.session;
    loading = false;
    await refreshSessions();
  }

  onMount(() => {
    refreshSessions().then(() => loadSession(selectedSessionId)).catch((e) => {
      error = String(e);
      loading = false;
    });
  });
</script>

<main class="layout">
  <aside class="sidebar">
    <h1>Senaka Debug UI</h1>
    <div class="row">
      <button on:click={refreshSessions}>Refresh</button>
    </div>
    <div class="row">
      <input placeholder="session id" bind:value={newSessionId} />
      <button on:click={createOrSelectSession}>Open</button>
    </div>

    <ul>
      {#each sessions as s}
        <li>
          <button class:selected={s.id === selectedSessionId} on:click={() => loadSession(s.id)}>
            <span>{s.id}</span>
            <small>{s.messageCount} msgs</small>
          </button>
        </li>
      {/each}
    </ul>
  </aside>

  <section class="chat">
    <header>
      <h2>Session: {selectedSessionId}</h2>
      <button on:click={resetCurrentSession}>Reset Session</button>
    </header>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="thread">
      {#if selectedSession}
        {#each selectedSession.messages as m}
          <article class={`msg ${m.role}`}>
            <strong>{m.role}</strong>
            <pre>{m.content}</pre>
          </article>
        {/each}
      {:else if loading}
        <p>loading...</p>
      {/if}
    </div>

    <footer>
      <textarea bind:value={userInput} placeholder="type message"></textarea>
      <button disabled={loading} on:click={sendTurn}>Send</button>
    </footer>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: 'IBM Plex Sans', 'Noto Sans KR', sans-serif;
    background: radial-gradient(circle at 20% 10%, #1d2e4a, #0f172a 45%, #05080f 100%);
    color: #e9eef9;
  }

  .layout {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 320px 1fr;
  }

  .sidebar {
    border-right: 1px solid #2d3f62;
    padding: 16px;
    background: rgba(13, 22, 38, 0.7);
    backdrop-filter: blur(6px);
  }

  .row {
    display: flex;
    gap: 8px;
    margin-bottom: 10px;
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
  }

  li button {
    width: 100%;
    text-align: left;
    background: #12213a;
    border: 1px solid #2b446e;
    color: #dbeafe;
    border-radius: 10px;
    padding: 10px;
    display: flex;
    justify-content: space-between;
  }

  li button.selected {
    border-color: #60a5fa;
    box-shadow: 0 0 0 1px #60a5fa;
  }

  .chat {
    display: grid;
    grid-template-rows: auto 1fr auto;
    padding: 16px;
    gap: 12px;
  }

  .thread {
    overflow: auto;
    border: 1px solid #2b446e;
    border-radius: 12px;
    padding: 12px;
    background: rgba(8, 13, 24, 0.7);
  }

  .msg {
    margin-bottom: 12px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid #243959;
  }

  .msg.user { background: #12253f; }
  .msg.assistant { background: #102a27; border-color: #2d6b63; }
  .msg.system { background: #31220f; border-color: #7a5f30; }

  pre {
    white-space: pre-wrap;
    word-break: break-word;
    margin: 6px 0 0;
    font-family: 'JetBrains Mono', monospace;
  }

  textarea {
    width: 100%;
    min-height: 96px;
    border-radius: 10px;
    border: 1px solid #355481;
    background: #0b162b;
    color: #e9eef9;
    padding: 10px;
    resize: vertical;
  }

  .error {
    color: #fecaca;
    margin: 0;
  }

  @media (max-width: 860px) {
    .layout {
      grid-template-columns: 1fr;
    }

    .sidebar {
      border-right: none;
      border-bottom: 1px solid #2d3f62;
    }
  }
</style>
