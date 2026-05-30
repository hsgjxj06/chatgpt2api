"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, LoaderCircle, Paperclip, SendHorizontal, Settings2, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
const JSON_PLACEHOLDER = "留空表示不发送；填写 JSON 对象或数组";

const emptyAdvancedSettings = {
  temperature: "",
  top_p: "",
  max_completion_tokens: "",
  max_tokens: "",
  presence_penalty: "",
  frequency_penalty: "",
  n: "",
  stop: "",
  seed: "",
  top_logprobs: "",
  prompt_cache_key: "",
  prompt_cache_retention: "",
  safety_identifier: "",
  reasoning_effort: "",
  verbosity: "",
  service_tier: "",
  response_format: '{"type":"text"}',
  modalities: "text",
  store: false,
  stream: false,
  logprobs: false,
  parallel_tool_calls: true,
  metadata: "",
  audio: "",
  tools: "",
  tool_choice: "",
  functions: "",
  function_call: "",
  logit_bias: "",
  prediction: "",
  stream_options: "",
  web_search_options: "",
  user: "",
};

type AdvancedSettings = typeof emptyAdvancedSettings;

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
  dataUrl: string;
  textPreview?: string;
};

type FieldConfig = {
  key: keyof AdvancedSettings;
  label: string;
  placeholder?: string;
  type?: "number" | "text";
  deprecated?: boolean;
};

const numericFields: FieldConfig[] = [
  { key: "temperature", label: "temperature", placeholder: "例如 1", type: "number" },
  { key: "top_p", label: "top_p", placeholder: "例如 1", type: "number" },
  { key: "max_completion_tokens", label: "max_completion_tokens", placeholder: "最大输出 token", type: "number" },
  { key: "max_tokens", label: "max_tokens", placeholder: "旧字段", type: "number", deprecated: true },
  { key: "presence_penalty", label: "presence_penalty", placeholder: "-2 到 2", type: "number" },
  { key: "frequency_penalty", label: "frequency_penalty", placeholder: "-2 到 2", type: "number" },
  { key: "n", label: "n", placeholder: "默认 1", type: "number" },
  { key: "seed", label: "seed", placeholder: "确定性种子", type: "number" },
  { key: "top_logprobs", label: "top_logprobs", placeholder: "0-20", type: "number" },
];

const textFields: FieldConfig[] = [
  { key: "stop", label: "stop", placeholder: "字符串；多项用英文逗号分隔" },
  { key: "prompt_cache_key", label: "prompt_cache_key" },
  { key: "prompt_cache_retention", label: "prompt_cache_retention" },
  { key: "safety_identifier", label: "safety_identifier" },
  { key: "service_tier", label: "service_tier", placeholder: "auto / default / flex" },
  { key: "user", label: "user", deprecated: true },
];

const jsonFields: FieldConfig[] = [
  { key: "metadata", label: "metadata" },
  { key: "response_format", label: "response_format" },
  { key: "audio", label: "audio" },
  { key: "tools", label: "tools" },
  { key: "tool_choice", label: "tool_choice" },
  { key: "functions", label: "functions", deprecated: true },
  { key: "function_call", label: "function_call", deprecated: true },
  { key: "logit_bias", label: "logit_bias" },
  { key: "prediction", label: "prediction" },
  { key: "stream_options", label: "stream_options" },
  { key: "web_search_options", label: "web_search_options" },
];

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

function parseJsonField(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : "解析失败"}`);
  }
}

function addNumber(payload: Record<string, unknown>, settings: AdvancedSettings, key: keyof AdvancedSettings) {
  const value = String(settings[key] || "").trim();
  if (!value) {
    return;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${String(key)} 必须是数字`);
  }
  payload[key] = numberValue;
}

function buildRequestMessages(messages: UiMessage[], prompt: string, files: AttachedFile[]) {
  const history: ChatMessage[] = messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => ({ role: message.role, content: message.content }));

  const trimmedPrompt = prompt.trim();
  const content: string | ChatContentPart[] = files.length
    ? [
        ...(trimmedPrompt ? [{ type: "text" as const, text: trimmedPrompt }] : []),
        ...files.map((file) => ({
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

function buildChatPayload(model: string, messages: ChatMessage[], settings: AdvancedSettings): ChatCompletionRequest {
  const payload: Record<string, unknown> = { model, messages };

  numericFields.forEach((field) => addNumber(payload, settings, field.key));
  textFields.forEach((field) => {
    const value = String(settings[field.key] || "").trim();
    if (!value) {
      return;
    }
    payload[field.key] = field.key === "stop" && value.includes(",")
      ? value.split(",").map((item) => item.trim()).filter(Boolean)
      : value;
  });

  const modalities = settings.modalities.split(",").map((item) => item.trim()).filter(Boolean);
  if (modalities.length > 0) {
    payload.modalities = modalities;
  }

  (["store", "stream", "logprobs", "parallel_tool_calls"] as const).forEach((key) => {
    payload[key] = settings[key];
  });

  if (settings.reasoning_effort) {
    payload.reasoning_effort = settings.reasoning_effort;
  }
  if (settings.verbosity) {
    payload.verbosity = settings.verbosity;
  }

  jsonFields.forEach((field) => {
    const parsed = parseJsonField(String(settings[field.key] || ""), field.label);
    if (parsed !== undefined) {
      payload[field.key] = parsed;
    }
  });

  return payload as ChatCompletionRequest;
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
  const [models, setModels] = useState<string[]>([DEFAULT_CHAT_MODEL]);
  const [model, setModel] = useState(DEFAULT_CHAT_MODEL);
  const [customModel, setCustomModel] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [settings, setSettings] = useState<AdvancedSettings>(emptyAdvancedSettings);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
    if (stored) {
      setModel(stored);
    }
  }, []);

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

  const selectedModel = customModel.trim() || model;

  const canSend = useMemo(() => {
    return !isLoading && selectedModel.trim() && (prompt.trim() || files.length > 0);
  }, [files.length, isLoading, prompt, selectedModel]);

  const updateSetting = (key: keyof AdvancedSettings, value: string | boolean) => {
    setSettings((current) => ({ ...current, [key]: value }));
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
    let requestMessages: ChatMessage[];
    let payload: ChatCompletionRequest;
    try {
      requestMessages = buildRequestMessages(messages, userPrompt, attachedFiles);
      payload = buildChatPayload(selectedModel, requestMessages, settings);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "参数配置错误");
      return;
    }

    const userMessage: UiMessage = {
      id: createId(),
      role: "user",
      content: userPrompt || "[仅发送文件]",
      files: attachedFiles,
    };
    setMessages((current) => [...current, userMessage]);
    setPrompt("");
    setFiles([]);
    setIsLoading(true);
    window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, selectedModel);

    try {
      const response = await createChatCompletion(payload);
      const maybeStream = response as unknown;
      const firstChoice = typeof maybeStream === "string" ? undefined : response.choices[0];
      const content = (typeof maybeStream === "string" ? streamTextToAssistantText(maybeStream) : messageContentToText(firstChoice?.message))
        || "[模型没有返回文本内容]";
      setMessages((current) => [
        ...current,
        { id: createId(), role: "assistant", content },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content: `请求失败：${error instanceof Error ? error.message : "未知错误"}`,
        },
      ]);
      toast.error(error instanceof Error ? error.message : "请求失败");
    } finally {
      setIsLoading(false);
    }
  };

  if (isCheckingAuth || !session) {
    return <ChatLoading />;
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6">
      <section className="flex flex-col gap-4 rounded-[32px] border border-white/70 bg-white/80 p-5 shadow-[0_24px_80px_-60px_rgba(15,23,42,0.75)] backdrop-blur dark:border-white/10 dark:bg-stone-950/60">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-blue-600 dark:text-blue-300">/v1/chat/completions</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-50">对话调试台</h1>
            <p className="mt-2 max-w-3xl text-sm text-stone-500 dark:text-stone-400">
              默认使用 {DEFAULT_CHAT_MODEL}，支持切换模型、上传文件，并覆盖 Chat Completions 的常用与高级参数。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)] lg:w-[520px]">
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-stone-500 dark:text-stone-400">自定义模型（优先）</label>
              <Input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="例如 gpt-5.1" />
            </div>
          </div>
        </div>
      </section>

      <div className="grid flex-1 gap-5 lg:grid-cols-[1fr_360px]">
        <Card className="overflow-hidden rounded-[32px] border-white/70 bg-white/80 shadow-[0_24px_80px_-60px_rgba(15,23,42,0.75)] dark:border-white/10 dark:bg-stone-950/60">
          <CardContent className="flex h-[calc(100vh-14rem)] min-h-[520px] flex-col p-0">
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {messages.length === 0 ? (
                <div className="flex h-full min-h-80 items-center justify-center rounded-[28px] border border-dashed border-stone-200 bg-stone-50/80 text-center dark:border-white/10 dark:bg-white/5">
                  <div className="max-w-sm px-6">
                    <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-stone-950 text-white dark:bg-white dark:text-stone-950">
                      <SendHorizontal className="size-5" />
                    </div>
                    <h2 className="text-base font-semibold text-stone-900 dark:text-stone-50">开始一次对话</h2>
                    <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">输入问题、附加文件，并按需展开右侧高级参数后发送。</p>
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
                  <Button type="button" variant="ghost" size="icon" onClick={() => setMessages([])} title="清空对话">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <aside className="space-y-4">
          <Card className="rounded-[28px] border-white/70 bg-white/80 dark:border-white/10 dark:bg-stone-950/60">
            <CardContent className="space-y-4 p-5">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                onClick={() => setShowAdvanced((value) => !value)}
              >
                <span>
                  <span className="flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-50"><Settings2 className="size-4" /> 高级参数</span>
                  <span className="mt-1 block text-xs text-stone-500 dark:text-stone-400">覆盖官方 Chat Completions request body 字段</span>
                </span>
                <span className="text-xs text-stone-400">{showAdvanced ? "收起" : "展开"}</span>
              </button>

              {showAdvanced ? (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-2">
                    {(["store", "stream", "logprobs", "parallel_tool_calls"] as const).map((key) => (
                      <label key={key} className="flex items-center gap-2 rounded-2xl border border-stone-100 px-3 py-2 text-xs dark:border-white/10">
                        <Checkbox checked={settings[key]} onCheckedChange={(checked) => updateSetting(key, checked === true)} />
                        <span>{key}</span>
                      </label>
                    ))}
                  </div>

                  <div className="grid gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-stone-500">reasoning_effort</label>
                      <Select value={settings.reasoning_effort || "unset"} onValueChange={(value) => updateSetting("reasoning_effort", value === "unset" ? "" : value)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unset">不发送</SelectItem>
                          <SelectItem value="minimal">minimal</SelectItem>
                          <SelectItem value="low">low</SelectItem>
                          <SelectItem value="medium">medium</SelectItem>
                          <SelectItem value="high">high</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-stone-500">verbosity</label>
                      <Select value={settings.verbosity || "unset"} onValueChange={(value) => updateSetting("verbosity", value === "unset" ? "" : value)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="unset">不发送</SelectItem>
                          <SelectItem value="low">low</SelectItem>
                          <SelectItem value="medium">medium</SelectItem>
                          <SelectItem value="high">high</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400">数值字段</h3>
                    {numericFields.map((field) => (
                      <div key={field.key} className="space-y-1.5">
                        <label className="text-xs font-medium text-stone-500">{field.label}{field.deprecated ? "（deprecated）" : ""}</label>
                        <Input
                          type={field.type || "text"}
                          value={String(settings[field.key])}
                          onChange={(event) => updateSetting(field.key, event.target.value)}
                          placeholder={field.placeholder}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400">文本字段</h3>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-stone-500">modalities</label>
                      <Input value={settings.modalities} onChange={(event) => updateSetting("modalities", event.target.value)} placeholder="text 或 text,audio" />
                    </div>
                    {textFields.map((field) => (
                      <div key={field.key} className="space-y-1.5">
                        <label className="text-xs font-medium text-stone-500">{field.label}{field.deprecated ? "（deprecated）" : ""}</label>
                        <Input value={String(settings[field.key])} onChange={(event) => updateSetting(field.key, event.target.value)} placeholder={field.placeholder} />
                      </div>
                    ))}
                  </div>

                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400">JSON 字段</h3>
                    {jsonFields.map((field) => (
                      <div key={field.key} className="space-y-1.5">
                        <label className="text-xs font-medium text-stone-500">{field.label}{field.deprecated ? "（deprecated）" : ""}</label>
                        <Textarea
                          value={String(settings[field.key])}
                          onChange={(event) => updateSetting(field.key, event.target.value)}
                          placeholder={JSON_PLACEHOLDER}
                          className="min-h-20 rounded-2xl font-mono text-xs"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </main>
  );
}
