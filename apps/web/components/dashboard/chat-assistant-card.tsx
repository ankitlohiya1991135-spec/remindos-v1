"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

const STARTER_ID = "starter";

const starterMessage: ChatMessage = {
  id: STARTER_ID,
  role: "assistant",
  content:
    "Hi! I am your reminder assistant. Tell me what reminder you want to create or plan.",
  createdAt: new Date(0).toISOString(),
};

async function fetchHistory(): Promise<ChatMessage[]> {
  const res = await fetch("/api/chat/history");
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: { id: string; role: string; content: string; createdAt: string }[] };
  return (data.messages ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ id: m.id, role: m.role as ChatRole, content: m.content, createdAt: m.createdAt }));
}

async function persistMessages(messages: ChatMessage[]): Promise<void> {
  const storable = messages.filter((m) => m.id !== STARTER_ID);
  if (storable.length === 0) return;
  await fetch("/api/chat/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: storable.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })) }),
  });
}

export function ChatAssistantCard() {
  const [messages, setMessages] = useState<ChatMessage[]>([starterMessage]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const canSend = useMemo(() => input.trim().length > 0 && !isLoading && historyLoaded, [input, isLoading, historyLoaded]);

  // Load persisted history once on mount
  useEffect(() => {
    fetchHistory().then((history) => {
      if (history.length > 0) {
        setMessages(history);
      }
      setHistoryLoaded(true);
    });
  }, []);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const handleQuickCreate = () => {
      setInput("Create a reminder for tomorrow at 9:00 AM to review my priorities.");
      textareaRef.current?.focus();
    };

    window.addEventListener("reminder:quick-create", handleQuickCreate);
    return () => window.removeEventListener("reminder:quick-create", handleQuickCreate);
  }, []);

  const handleSend = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || isLoading || !historyLoaded) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    let assistantMessage: ChatMessage | null = null;

    try {
      const timeZone =
        typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMessage].map((message) => ({
            role: message.role,
            content: message.content,
          })),
          ...(timeZone ? { timeZone } : {}),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to get assistant response.");
      }

      const data = (await response.json()) as { message?: string };
      const assistantContent = data.message?.trim();

      if (!assistantContent) {
        throw new Error("Assistant response was empty.");
      }

      assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: assistantContent,
        createdAt: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage!]);
    } catch {
      assistantMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "I could not respond right now. Please check your AI API configuration and try again.",
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMessage!]);
    } finally {
      setIsLoading(false);
      // Persist both the user message and the assistant reply (best-effort)
      persistMessages([userMessage, ...(assistantMessage ? [assistantMessage] : [])]);
    }
  }, [input, isLoading, historyLoaded, messages]);

  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
        Reminder assistant chat
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
        Chat with AI to plan reminders and your daily schedule.
      </p>

      <div className="mt-4 h-80 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950">
        {!historyLoaded ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm text-slate-400 dark:text-slate-500">Loading chat…</span>
          </div>
        ) : (
          <div className="grid gap-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm ${
                  message.role === "user"
                    ? "ml-auto bg-violet-600 text-white"
                    : "bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100"
                }`}
              >
                {message.content}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <form ref={formRef} onSubmit={handleSend} className="mt-4 grid gap-3">
        <textarea
          ref={textareaRef}
          rows={3}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
          placeholder="Example: Remind me to pay rent every month on the 1st."
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-violet-500 transition focus:ring-2 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="w-fit rounded-full bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? "Thinking..." : "Send"}
        </button>
      </form>
    </article>
  );
}
