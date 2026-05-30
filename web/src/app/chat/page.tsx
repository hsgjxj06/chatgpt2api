"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, History, LoaderCircle, Paperclip, Plus, SendHorizontal, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createChatCompletion,
  fetchModels,
  type ChatCompletionRequest,
  type ChatContentPart,
  type ChatMessage,
} from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

const DEFAULT_CHAT_MODEL = "gpt-5-5";
const CHAT_MODEL_STORAGE_KEY = "chatgpt2api:chat_last_model";
const CHAT_CONVERSATIONS_STORAGE_KEY = "chatgpt2api:chat_conversations";
const ACTIVE_CONVERSATION_STORAGE_KEY = "chatgpt2api:chat_active_conversation_id";

type UiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  files?: AttachedFile[];
};

type AttachedFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
  textPreview?: string;
};

type ChatConversation = {
  id: string;
  title: string;
  model: string;
  messages: UiMessage[];
  createdAt: string;
  updatedAt: string;
};

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function readFileTextPreview(file: File) {
  const textLike = file.type.startsWith("text/") || /\.(json|md|csv|ts|tsx|js|jsx|py|java|go|rs|yaml|yml|txt)$/i.test(file.name);
  if (!textLike || file.size > 512 * 1024) {
    return Promise.resolve("");
  }
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").slice(0, 12000));
    reader.onerror = () => resolve("");
    reader.readAsText(file);
  });
}

function sanitizeMessages(messages: UiMessage[]) {
  return messages.map((message) => ({
    ...message,
    files: message.files?.map((file) => ({
      id: file.id,
      name: file.name,
      type: file.type,
      size: file.size,
    })),
  }));
}

function buildConversationTitle(messages: UiMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = String(firstUserMessage?.content || "新对话").trim();
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function loadConversations() {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const value = JSON.parse(window.localStorage.getItem(CHAT_CONVERSATIONS_STORAGE_KEY) || "[]") as ChatConversation[];
    return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string") : [];
  } catch {
    return [];
  }
}

function saveConversations(conversations: ChatConversation[]) {
  window.localStorage.setItem(CHAT_CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations.slice(0, 50)));
}

function buildRequestMessages(messages: UiMessage[], prompt: string, files: AttachedFile[]) {
  const history: ChatMessage[] = messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => ({ role: message.role, content: message.content }));

  const trimmedPrompt = prompt.trim();
  const content: string | ChatContentPart[] = files.length
    ? [
        ...(trimmedPrompt ? [{ type: "text" as const, text: trimmedPrompt }] : []),
        ...files
          .filter((file) => file.dataUrl)
          .map((file) => ({
            type: "file" as const,
            file: {
              filename: file.name,
              file_data: file.dataUrl,
            },
          })),
        ...files
          .filter((file) => file.textPreview)
          .map((file) => ({
            type: "text" as const,
            text: `\n\n[文件 ${file.name} 的文本预览]\n${file.textPreview}`,
          })),
      ]
    : trimmedPrompt;

  return [...history, { role: "user" as const, content }];
}

function buildChatPayload(model: string, messages: ChatMessage[]): ChatCompletionRequest {
  return { model, messages };
}

function streamTextToAssistantText(value: string) {
  const parts: string[] = [];
  value.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    try {
      const item = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }> };
      const choice = item.choices?.[0];
      const content = choice?.delta?.content || choice?.message?.content || "";
      if (content) {
        parts.push(content);
      }
    } catch {
      // Ignore keepalive or malformed streaming lines from proxies.
    }
  });
  return parts.join("");
}

function messageContentToText(message?: ChatMessage) {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part.type === "text") {
          return part.text;
        }
        if (part.type === "file") {
          return `[文件：${part.file.filename || part.file.file_id || "未命名"}]`;
        }
        return "[图片]";
      })
      .join("\n");
  }
  return "";
}

function ChatLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <LoaderCircle className="size-5 animate-spin text-stone-400" />
    </div>
  );
}

export default function ChatPage() {
  const { isCheckingAuth, session } = useAuthGuard();
  const [conversations, setConversations] = useState<ChatConversation[]>(() => loadConversations());
  const initialActiveConversation = useMemo(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const storedActiveId = window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY) || "";
    return conversations.find((item) => item.id === storedActiveId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [models, setModels] = useState<string[]>([DEFAULT_CHAT_MODEL]);
  const [model, setModel] = useState(() => {
    if (initialActiveConversation?.model) {
      return initialActiveConversation.model;
    }
    if (typeof window === "undefined") {
      return DEFAULT_CHAT_MODEL;
    }
    return window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY) || DEFAULT_CHAT_MODEL;
  });
  const [messages, setMessages] = useState<UiMessage[]>(() => initialActiveConversation?.messages || []);
  const [activeConversationId, setActiveConversationId] = useState(() => initialActiveConversation?.id || "");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    fetchModels()
      .then((result) => {
        if (!active) {
          return;
        }
        const ids = result.data.map((item) => item.id).filter(Boolean);
        const merged = Array.from(new Set([DEFAULT_CHAT_MODEL, ...ids]));
        setModels(merged);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : "加载模型失败"));
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  const canSend = useMemo(() => {
    return !isLoading && model.trim() && (prompt.trim() || files.length > 0);
  }, [files.length, isLoading, prompt, model]);

  const persistConversation = (conversationId: string, nextMessages: UiMessage[], nextModel: string) => {
    const now = new Date().toISOString();
    const existing = conversations.find((item) => item.id === conversationId);
    const nextConversation: ChatConversation = {
      id: conversationId,
      title: buildConversationTitle(nextMessages),
      model: nextModel,
      messages: sanitizeMessages(nextMessages),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const nextConversations = [
      nextConversation,
      ...conversations.filter((item) => item.id !== conversationId),
    ].slice(0, 50);
    setConversations(nextConversations);
    saveConversations(nextConversations);
    setActiveConversationId(conversationId);
    window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
    window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, nextModel);
  };

  const handleNewConversation = () => {
    setActiveConversationId("");
    setMessages([]);
    setPrompt("");
    setFiles([]);
    window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  };

  const handleSelectConversation = (conversation: ChatConversation) => {
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setModel(conversation.model || DEFAULT_CHAT_MODEL);
    setPrompt("");
    setFiles([]);
    window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversation.id);
  };

  const handleDeleteConversation = (conversationId: string) => {
    const nextConversations = conversations.filter((item) => item.id !== conversationId);
    setConversations(nextConversations);
    saveConversations(nextConversations);
    if (conversationId === activeConversationId) {
      handleNewConversation();
    }
  };

  const handleFiles = async (items: FileList | null) => {
    if (!items?.length) {
      return;
    }
    const uploadFiles = Array.from(items).slice(0, 8);
    try {
      const nextFiles = await Promise.all(
        uploadFiles.map(async (file) => ({
          id: createId(),
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: await readFileAsDataUrl(file),
          textPreview: await readFileTextPreview(file),
        })),
      );
      setFiles((current) => [...current, ...nextFiles]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取文件失败");
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleSubmit = async () => {
    if (!canSend) {
      return;
    }
    const userPrompt = prompt.trim();
    const attachedFiles = files;
    const conversationId = activeConversationId || createId();
    const requestMessages = buildRequestMessages(messages, userPrompt, attachedFiles);
    const payload = buildChatPayload(model, requestMessages);
    const userMessage: UiMessage = {
      id: createId(),
      role: "user",
      content: userPrompt || "[仅发送文件]",
      files: attachedFiles,
    };
    const messagesWithUser = [...messages, userMessage];

    setMessages(messagesWithUser);
    persistConversation(conversationId, messagesWithUser, model);
    setPrompt("");
    setFiles([]);
    setIsLoading(true);

    try {
      const response = await createChatCompletion(payload);
      const maybeStream = response as unknown;
      const firstChoice = typeof maybeStream === "string" ? undefined : response.choices[0];
      const content = (typeof maybeStream === "string" ? streamTextToAssistantText(maybeStream) : messageContentToText(firstChoice?.message))
        || "[模型没有返回文本内容]";
      const nextMessages = [
        ...messagesWithUser,
        { id: createId(), role: "assistant" as const, content },
      ];
      setMessages(nextMessages);
      persistConversation(conversationId, nextMessages, model);
    } catch (error) {
      const nextMessages = [
        ...messagesWithUser,
        {
          id: createId(),
          role: "assistant" as const,
          content: `请求失败：${error instanceof Error ? error.message : "未知错误"}`,
        },
      ];
      setMessages(nextMessages);
      persistConversation(conversationId, nextMessages, model);
      toast.error(error instanceof Error ? error.message : "请求失败");
    } finally {
      setIsLoading(false);
    }
  };

  if (isCheckingAuth || !session) {
    return <ChatLoading />;
  }

  return (
    <main className="mx-auto grid min-h-[calc(100vh-3rem)] w-full max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:grid-cols-[300px_1fr]">
      <aside className="space-y-4">
        <Card className="rounded-[28px] border-white/70 bg-white/80 shadow-[0_24px_80px_-60px_rgba(15,23,42,0.75)] dark:border-white/10 dark:bg-stone-950/60">
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-50">
                <History className="size-4" />
                历史对话
              </div>
              <Button type="button" size="sm" variant="outline" onClick={handleNewConversation}>
                <Plus className="size-4" />
                新对话
              </Button>
            </div>
            <div className="max-h-[calc(100vh-12rem)] space-y-2 overflow-y-auto pr-1">
              {conversations.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-stone-200 px-3 py-8 text-center text-sm text-stone-400 dark:border-white/10">
                  暂无历史
                </div>
              ) : conversations.map((conversation) => {
                const active = conversation.id === activeConversationId;
                return (
                  <div
                    key={conversation.id}
                    className={cn(
                      "group flex items-start gap-2 rounded-2xl border px-3 py-2 transition",
                      active
                        ? "border-stone-950 bg-stone-950 text-white dark:border-white dark:bg-white dark:text-stone-950"
                        : "border-stone-100 bg-white/70 text-stone-700 hover:border-stone-200 hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-stone-200 dark:hover:bg-white/10",
                    )}
                  >
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => handleSelectConversation(conversation)}>
                      <div className="truncate text-sm font-medium">{conversation.title}</div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] opacity-60">
                        <span>{conversation.model}</span>
                        <span>{formatConversationTime(conversation.updatedAt)}</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={cn("mt-0.5 opacity-50 transition hover:text-rose-500 hover:opacity-100", active && "hover:text-rose-300")}
                      onClick={() => handleDeleteConversation(conversation.id)}
                      title="删除对话"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </aside>

      <section className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-3 rounded-[32px] border border-white/70 bg-white/80 p-5 shadow-[0_24px_80px_-60px_rgba(15,23,42,0.75)] backdrop-blur dark:border-white/10 dark:bg-stone-950/60 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">对话</h1>
          <div className="w-full space-y-1.5 sm:w-72">
            <label className="text-xs font-medium text-stone-500 dark:text-stone-400">模型</label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                {models.map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <Card className="min-w-0 flex-1 overflow-hidden rounded-[32px] border-white/70 bg-white/80 shadow-[0_24px_80px_-60px_rgba(15,23,42,0.75)] dark:border-white/10 dark:bg-stone-950/60">
          <CardContent className="flex h-[calc(100vh-14rem)] min-h-[520px] flex-col p-0">
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {messages.length === 0 ? (
                <div className="flex h-full min-h-80 items-center justify-center rounded-[28px] border border-dashed border-stone-200 bg-stone-50/80 text-center dark:border-white/10 dark:bg-white/5">
                  <div className="max-w-sm px-6">
                    <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-stone-950 text-white dark:bg-white dark:text-stone-950">
                      <SendHorizontal className="size-5" />
                    </div>
                    <h2 className="text-base font-semibold text-stone-900 dark:text-stone-50">开始一次对话</h2>
                    <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">输入消息或添加文件后发送。</p>
                  </div>
                </div>
              ) : (
                messages.map((message) => (
                  <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                    <div className={cn(
                      "max-w-[82%] rounded-[24px] px-4 py-3 text-sm shadow-sm",
                      message.role === "user"
                        ? "bg-stone-950 text-white dark:bg-white dark:text-stone-950"
                        : "border border-stone-100 bg-white text-stone-800 dark:border-white/10 dark:bg-white/10 dark:text-stone-100",
                    )}>
                      <div className="mb-1 text-[11px] font-medium opacity-60">{message.role === "user" ? "你" : "助手"}</div>
                      <div className="whitespace-pre-wrap leading-6">{message.content}</div>
                      {message.files?.length ? (
                        <div className="mt-3 space-y-1.5">
                          {message.files.map((file) => (
                            <div key={file.id} className="flex items-center gap-2 rounded-xl bg-black/10 px-2 py-1 text-xs dark:bg-white/10">
                              <FileText className="size-3.5" />
                              <span className="truncate">{file.name}</span>
                              <span className="opacity-60">{formatBytes(file.size)}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
              {isLoading ? (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl border border-stone-100 bg-white px-4 py-3 text-sm text-stone-500 dark:border-white/10 dark:bg-white/10 dark:text-stone-300">
                    <LoaderCircle className="size-4 animate-spin" />
                    正在请求模型...
                  </div>
                </div>
              ) : null}
              <div ref={bottomRef} />
            </div>

            <div className="border-t border-stone-100 p-4 dark:border-white/10">
              {files.length ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {files.map((file) => (
                    <div key={file.id} className="flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs text-stone-600 dark:border-white/10 dark:bg-white/10 dark:text-stone-300">
                      <FileText className="size-3.5" />
                      <span className="max-w-40 truncate">{file.name}</span>
                      <span>{formatBytes(file.size)}</span>
                      <button
                        type="button"
                        className="text-stone-400 hover:text-rose-500"
                        onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex gap-2">
                <Textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="输入消息，Shift + Enter 换行"
                  className="min-h-24 flex-1 resize-none"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleSubmit();
                    }
                  }}
                />
                <div className="flex flex-col gap-2">
                  <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void handleFiles(event.target.files)} />
                  <Button type="button" variant="outline" size="icon" onClick={() => fileInputRef.current?.click()} title="添加文件">
                    <Paperclip className="size-4" />
                  </Button>
                  <Button type="button" size="icon" disabled={!canSend} onClick={() => void handleSubmit()} title="发送">
                    <SendHorizontal className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
