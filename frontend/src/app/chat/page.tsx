"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Send, Music, Video, Paperclip, X, ChevronDown, ChevronRight, Activity, Download, Sparkles, Globe } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// ── Types ──────────────────────────────────────────────────────────────────────

type AssetClassification = {
    semantics?: {
        confidence?: number;
        composition?: string;
        camera_angle?: string;
        lighting?: string;
        mood?: string;
        atmosphere?: string;
        primary_activity?: string;
    };
    origin?: "generated" | "scraped";
};

type RelevantAsset = {
    media_url?: string;
    filename?: string;
    type?: "image" | "video" | "audio";
    source?: string;          // "fal_ai" for generated, domain string for scraped
    model_id?: string;        // e.g. "fal-ai/flux/dev"
    relevance_score?: number; // Real GPT-4o score from relevanceMatcher (0.0–1.0)
    description?: string;
    alt?: string;
    classification?: AssetClassification;
};

type DecisionReasoning = {
    reasoning_trace?: string;
    final_decision?: string;
    decision_confidence?: number;
};

type AgentData = {
    relevant_assets?: RelevantAsset[];
    decision_reasoning?: DecisionReasoning;
};

type Message = {
    id: string;
    role: "user" | "assistant";
    content: string;
    mediaFile?: string;
    media_type?: "image" | "video" | "audio";
    agentData?: AgentData;
};

// ── Asset URL helper ────────────────────────────────────────────────────────────

const getAssetUrl = (asset: RelevantAsset): string => {
    if (asset.media_url) return asset.media_url;
    if (asset.filename) {
        const idx = asset.filename.indexOf("scrape_assets");
        if (idx !== -1) {
            const relativePath = asset.filename.substring(idx + 14).replace(/\\/g, "/");
            return `${API_URL}/assets/${relativePath}`;
        }
    }
    return "";
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function ChatPage() {
    const [currentChatId, setCurrentChatId] = useState<string | null>(null);
    const [messages, setMessages] = useState<Message[]>([
        {
            id: "1",
            role: "assistant",
            content: "Hello! I'm AutoGenie — ready to generate and analyze multimodal media. Describe what you'd like to create or analyze.",
        },
    ]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [pipelineLogs, setPipelineLogs] = useState<string[]>([]);
    const [showLogs, setShowLogs] = useState(false);

    const [selectedMedia, setSelectedMedia] = useState<File | null>(null);
    const [mediaPreview, setMediaPreview] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const logScrollRef = useRef<HTMLDivElement>(null);

    // Auto scroll chat
    useEffect(() => {
        scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, pipelineLogs]);

    // Auto scroll logs
    useEffect(() => {
        logScrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [pipelineLogs, showLogs]);

    const handleMediaSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            setSelectedMedia(file);
            setMediaPreview(URL.createObjectURL(file));
        }
    };

    const removeMedia = () => {
        setSelectedMedia(null);
        setMediaPreview(null);
    };

    const handleSubmit = async () => {
        if (!input.trim() && !selectedMedia) return;

        let mediaType: "image" | "video" | "audio" | undefined;
        if (selectedMedia) {
            if (selectedMedia.type.startsWith("video/")) mediaType = "video";
            else if (selectedMedia.type.startsWith("audio/")) mediaType = "audio";
            else mediaType = "image";
        }

        const newUserMsg: Message = {
            id: Date.now().toString(),
            role: "user",
            content: input.trim(),
            mediaFile: mediaPreview || undefined,
            media_type: mediaType,
        };

        setMessages((prev) => [...prev, newUserMsg]);
        setInput("");
        setIsLoading(true);
        setPipelineLogs(["Initializing Pipeline..."]);
        setShowLogs(false);

        // ── Supabase: create chat session ───────────────────────────────────────
        let chatIdToUse = currentChatId;
        if (!chatIdToUse) {
            const newChatId = uuidv4();
            setCurrentChatId(newChatId);
            chatIdToUse = newChatId;

            const { error } = await supabase.from("chats").insert([{
                id: newChatId,
                title: input.slice(0, 50) + (input.length > 50 ? "..." : ""),
            }]);
            if (error) {
                console.error("Supabase chat insert error:", error);
                toast.error("Could not create chat session in database.");
            }
        }

        // ── Supabase: save user message ─────────────────────────────────────────
        const userMessageId = uuidv4();
        const { error: msgErr } = await supabase.from("messages").insert([{
            id: userMessageId,
            chat_id: chatIdToUse,
            role: "user",
            content: newUserMsg.content,
            media_type: mediaType || null,
        }]);
        if (msgErr) {
            console.error("Supabase user message insert error:", msgErr);
            toast.error("Could not save message to database.");
        }

        // ── Pre-flight: check modality refinement ───────────────────────────────
        let inferredModality: string | undefined;
        try {
            const refineRes = await fetch(`${API_URL}/api/refine`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: newUserMsg.content }),
            });

            if (refineRes.ok) {
                const refinement = await refineRes.json();

                if (!refinement.isComplete) {
                    const assistantMsgId = uuidv4();
                    const clarificationMsg: Message = {
                        id: assistantMsgId,
                        role: "assistant",
                        content: refinement.message || "Could you specify if you want an image, video, or audio generated?",
                    };

                    setMessages((prev) => [...prev, clarificationMsg]);
                    setIsLoading(false);

                    await supabase.from("messages").insert([{
                        id: assistantMsgId,
                        chat_id: chatIdToUse,
                        role: "assistant",
                        content: clarificationMsg.content,
                    }]);

                    return;
                }

                if (refinement.modality) {
                    inferredModality = refinement.modality;
                }
            }
        } catch (e) {
            console.warn("Refinement check failed, proceeding to pipeline anyway...", e);
        }

        const formData = new FormData();
        formData.append("prompt", newUserMsg.content);
        formData.append("count", "1");
        formData.append("modality", inferredModality || mediaType || "image");
        if (selectedMedia) {
            formData.append("mediaFile", selectedMedia);
            formData.append("mediaType", mediaType || "image");
        }

        removeMedia();

        try {
            // ── SSE Streaming ─────────────────────────────────────────────────────
            const res = await fetch(`${API_URL}/api/run-pipeline`, {
                method: "POST",
                body: formData,
            });

            if (!res.body) throw new Error("No readable stream from server.");

            const reader = res.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;

                    const jsonStr = line.slice(6);
                    try {
                        const data = JSON.parse(jsonStr);

                        if (data.type === "log" || data.type === "error") {
                            const msg: string = data.message?.trim() || "";

                            // Skip empty / noisy lines
                            if (!msg || msg.includes("===") || msg.includes("---") || msg.toLowerCase().includes("dotenv")) {
                                continue; // ✅ FIX: was incorrectly `return` before
                            }

                            const hasEmoji = /[\u2700-\u27BF\uE000-\uF8FF\uD83C\uD000-\uDFFF\uD83D\uD000-\uDFFF\u2011-\u26FF\uD83E\uD000-\uDFFF]/.test(msg);
                            const lowerMsg = msg.toLowerCase();
                            const isHighLevel =
                                hasEmoji ||
                                lowerMsg.includes("scraping") ||
                                lowerMsg.includes("generating") ||
                                lowerMsg.includes("ready") ||
                                lowerMsg.includes("error") ||
                                lowerMsg.includes("finished") ||
                                lowerMsg.includes("saving") ||
                                lowerMsg.includes("pipeline") ||
                                lowerMsg.includes("classification") ||
                                lowerMsg.includes("relevance");

                            if (isHighLevel) {
                                setPipelineLogs((prev) => {
                                    if (prev[prev.length - 1] === msg) return prev;
                                    return [...prev, msg];
                                });
                            }
                        } else if (data.type === "done") {
                            const agentData: AgentData | undefined = data.data || undefined;

                            const assistantSummary = agentData?.relevant_assets?.length
                                ? `Pipeline complete — ${agentData.relevant_assets.length} asset${agentData.relevant_assets.length > 1 ? "s" : ""} returned.`
                                : data.success
                                    ? "Pipeline completed successfully."
                                    : "Pipeline encountered an error during execution.";

                            const newAgentMsg: Message = {
                                id: uuidv4(),
                                role: "assistant",
                                content: assistantSummary,
                                agentData,
                            };

                            setMessages((prev) => [...prev, newAgentMsg]);

                            // ── Supabase: save assistant message with full agent_data ──
                            const { error: agentErr } = await supabase.from("messages").insert([{
                                id: newAgentMsg.id,
                                chat_id: chatIdToUse,
                                role: "assistant",
                                content: assistantSummary,
                                agent_data: agentData ?? null,
                            }]);
                            if (agentErr) {
                                console.error("Supabase assistant message insert error:", agentErr);
                            }

                            setIsLoading(false);
                        }
                    } catch (err) {
                        console.error("SSE parse error", err);
                    }
                }
            }
        } catch (error) {
            console.error("Pipeline error:", error);
            toast.error("Pipeline failed. Is the API server running?");
            setMessages((prev) => [
                ...prev,
                {
                    id: Date.now().toString(),
                    role: "assistant",
                    content: "⚠️ Could not reach the pipeline server. Please ensure the API is running on the correct port.",
                },
            ]);
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    return (
        <div className="flex flex-col h-[100dvh] bg-black text-zinc-100 font-sans relative overflow-hidden">

            {/* Header */}
            <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-900 bg-black sticky top-0 z-10 w-full">
                <div className="flex items-center gap-3">
                    <Avatar className="w-8 h-8 rounded shrink-0">
                        <AvatarImage src="/bot.png" />
                        <AvatarFallback className="bg-indigo-600 text-white text-xs font-bold rounded">
                            <Sparkles className="w-4 h-4" />
                        </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                        <h1 className="text-base font-semibold tracking-tight text-white leading-none">AutoGenie</h1>
                        <span className="text-[10px] text-zinc-500 font-mono">Agentic Multimodal Pipeline</span>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-[11px] text-zinc-500">Pipeline Ready</span>
                </div>
            </header>

            {/* Chat Area */}
            <div className="flex-1 w-full bg-[#0a0a0a] overflow-y-auto overflow-x-hidden custom-scrollbar">
                <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 md:px-8 pt-10 pb-[250px] space-y-12">
                    <AnimatePresence>
                        {messages.map((msg) => (
                            <motion.div
                                key={msg.id}
                                initial={{ opacity: 0, y: 10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className={`flex flex-col w-full ${msg.role === "user" ? "items-end" : "items-start"}`}
                            >
                                <div className={`flex flex-col max-w-[90%] sm:max-w-[85%] ${msg.role === "user" ? "items-end" : "items-start"}`}>

                                    {/* Bot Label */}
                                    {msg.role === "assistant" && (
                                        <div className="flex items-center gap-2 mb-2 ml-1">
                                            <span className="text-xs font-semibold text-zinc-400">AutoGenie</span>
                                        </div>
                                    )}

                                    {/* User's Attached Media */}
                                    {msg.mediaFile && msg.role === "user" && (
                                        <div className="mb-3 rounded-lg overflow-hidden border border-zinc-800 bg-zinc-900/50 max-w-[240px]">
                                            {msg.media_type === "video" ? (
                                                <video src={msg.mediaFile} controls className="w-full h-auto object-cover" />
                                            ) : msg.media_type === "audio" ? (
                                                <audio src={msg.mediaFile} controls className="p-2 w-full" />
                                            ) : (
                                                <img src={msg.mediaFile} alt="Attached" className="w-full h-auto object-cover" />
                                            )}
                                        </div>
                                    )}

                                    {/* Text Content */}
                                    {msg.content && (
                                        <div
                                            className={
                                                msg.role === "user"
                                                    ? "px-5 py-3 rounded-2xl rounded-tr-sm text-[15px] leading-relaxed bg-zinc-100 text-black font-medium"
                                                    : "text-[15px] leading-[1.7] text-zinc-300 font-normal"
                                            }
                                        >
                                            {msg.content}
                                        </div>
                                    )}

                                    {/* Generated & Relevant Assets */}
                                    {msg.role === "assistant" && msg.agentData?.relevant_assets && msg.agentData.relevant_assets.length > 0 && (
                                        <div className="flex flex-col gap-6 mt-6 w-full">
                                            {msg.agentData.relevant_assets.map((asset, idx) => {
                                                const url = getAssetUrl(asset);
                                                // Multi-condition check: covers current "fal_ai" tag,
                                                // the classifier's origin field, AND old model-name strings
                                                const isGenerated =
                                                    asset.source === "fal_ai" ||
                                                    asset.classification?.origin === "generated" ||
                                                    (!!asset.source && asset.source.toLowerCase().includes("fal"));
                                                return (
                                                    <div
                                                        key={idx}
                                                        className={`flex flex-col sm:flex-row gap-4 p-4 rounded-xl border w-full transition ${isGenerated
                                                            ? "border-indigo-500/30 bg-indigo-950/20 hover:bg-indigo-950/30"
                                                            : "border-zinc-800 bg-zinc-900/40 hover:bg-zinc-800/20"
                                                            }`}
                                                    >
                                                        {/* Media */}
                                                        <div className="w-full sm:w-[240px] relative group rounded-lg overflow-hidden flex-shrink-0 bg-black border border-zinc-800/60 aspect-video sm:aspect-auto sm:h-[180px]">
                                                            {asset.type === "video" ? (
                                                                <video src={url} autoPlay loop muted playsInline className="w-full h-full object-cover" />
                                                            ) : asset.type === "audio" ? (
                                                                <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                                                                    <Music className="w-8 h-8 text-zinc-500" />
                                                                    <audio src={url} controls className="w-[90%] h-8" />
                                                                </div>
                                                            ) : (
                                                                <img
                                                                    src={url}
                                                                    alt={asset.description || "Asset"}
                                                                    className="w-full h-full object-cover"
                                                                />
                                                            )}
                                                            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition z-10">
                                                                <a href={url} download={`Asset_${idx}`} target="_blank" rel="noreferrer">
                                                                    <div className="bg-zinc-800/90 p-1.5 rounded-md hover:bg-zinc-700 cursor-pointer backdrop-blur-sm border border-zinc-600">
                                                                        <Download className="w-4 h-4 text-zinc-200" />
                                                                    </div>
                                                                </a>
                                                            </div>
                                                        </div>

                                                        {/* Details */}
                                                        <div className="flex flex-1 flex-col gap-3">
                                                            <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-wider border-b border-zinc-800/50 pb-2">
                                                                {/* Source Badge */}
                                                                {isGenerated ? (
                                                                    <span className="flex items-center gap-1.5 text-indigo-400 bg-indigo-500/10 border border-indigo-500/30 px-2 py-0.5 rounded-full">
                                                                        <Sparkles className="w-3 h-3" />
                                                                        FAL AI Generated
                                                                    </span>
                                                                ) : (
                                                                    <span className="flex items-center gap-1.5 text-zinc-400 bg-zinc-800/50 border border-zinc-700 px-2 py-0.5 rounded-full">
                                                                        <Globe className="w-3 h-3" />
                                                                        Web Scraped Match
                                                                    </span>
                                                                )}
                                                                {(asset.relevance_score !== undefined || asset.classification?.semantics?.confidence !== undefined) && (
                                                                    <span className="text-zinc-300 py-0.5 px-2 border border-zinc-700 rounded bg-zinc-800 font-mono">
                                                                        Relevance {(
                                                                            (asset.relevance_score ?? asset.classification?.semantics?.confidence ?? 0) * 100
                                                                        ).toFixed(0)}%
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <p className="text-[13px] text-zinc-300 leading-relaxed font-medium line-clamp-3">
                                                                {asset.description || asset.alt || "Relevant media returned by the pipeline relevance matcher."}
                                                            </p>

                                                            {/* Semantic Metadata Table */}
                                                            {asset.classification?.semantics && (
                                                                <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-auto text-[11px] text-zinc-400 font-mono bg-black/50 p-3 rounded border border-zinc-800/50">
                                                                    {typeof asset.classification.semantics.composition === "string" && (
                                                                        <div className="flex flex-col">
                                                                            <span className="text-zinc-600 text-[9px] mb-0.5">COMPOSITION</span>
                                                                            <span className="truncate" title={asset.classification.semantics.composition}>{asset.classification.semantics.composition}</span>
                                                                        </div>
                                                                    )}
                                                                    {typeof asset.classification.semantics.camera_angle === "string" && (
                                                                        <div className="flex flex-col">
                                                                            <span className="text-zinc-600 text-[9px] mb-0.5">ANGLE</span>
                                                                            <span className="truncate">{asset.classification.semantics.camera_angle}</span>
                                                                        </div>
                                                                    )}
                                                                    {typeof asset.classification.semantics.lighting === "string" && (
                                                                        <div className="flex flex-col">
                                                                            <span className="text-zinc-600 text-[9px] mb-0.5">LIGHTING</span>
                                                                            <span className="truncate">{asset.classification.semantics.lighting}</span>
                                                                        </div>
                                                                    )}
                                                                    {typeof asset.classification.semantics.mood === "string" && (
                                                                        <div className="flex flex-col">
                                                                            <span className="text-zinc-600 text-[9px] mb-0.5">MOOD</span>
                                                                            <span className="truncate">{asset.classification.semantics.mood}</span>
                                                                        </div>
                                                                    )}
                                                                    {typeof asset.classification.semantics.atmosphere === "string" && (
                                                                        <div className="flex flex-col">
                                                                            <span className="text-zinc-600 text-[9px] mb-0.5">ATMOSPHERE</span>
                                                                            <span className="truncate">{asset.classification.semantics.atmosphere}</span>
                                                                        </div>
                                                                    )}
                                                                    {typeof asset.classification.semantics.primary_activity === "string" && (
                                                                        <div className="flex flex-col">
                                                                            <span className="text-zinc-600 text-[9px] mb-0.5">ACTIVITY</span>
                                                                            <span className="truncate" title={asset.classification.semantics.primary_activity}>{asset.classification.semantics.primary_activity}</span>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* Agent Reasoning */}
                                    {msg.role === "assistant" && msg.agentData?.decision_reasoning?.reasoning_trace && (
                                        <div className="mt-6 p-4 rounded-xl border border-zinc-800/80 bg-zinc-900/20 text-sm">
                                            <div className="flex items-center gap-2 mb-3 text-zinc-400 uppercase tracking-widest text-[10px] font-bold">
                                                <Activity className="w-3.5 h-3.5" />
                                                Agent Decision Logic
                                            </div>
                                            <p className="text-zinc-400 text-[13px] leading-relaxed">
                                                {msg.agentData.decision_reasoning.reasoning_trace}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </motion.div>
                        ))}

                        {/* Loading / SSE State */}
                        {isLoading && (
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                className="flex flex-col w-full items-start"
                            >
                                <div className="flex items-center gap-2 mb-3 ml-1">
                                    <span className="text-xs font-semibold text-zinc-400">AutoGenie</span>
                                </div>
                                <div className="w-full max-w-lg border border-zinc-800 rounded-xl overflow-hidden bg-black">
                                    <button
                                        onClick={() => setShowLogs(!showLogs)}
                                        className="w-full px-4 py-3 flex items-center justify-between bg-zinc-900/40 hover:bg-zinc-900 transition-colors"
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
                                            <span className="text-[13px] font-medium text-zinc-300 truncate text-left max-w-[280px]">
                                                {pipelineLogs[pipelineLogs.length - 1] || "Initializing pipeline..."}
                                            </span>
                                        </div>
                                        {showLogs ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronRight className="w-4 h-4 text-zinc-500" />}
                                    </button>

                                    <AnimatePresence>
                                        {showLogs && (
                                            <motion.div
                                                initial={{ height: 0 }}
                                                animate={{ height: "auto" }}
                                                exit={{ height: 0 }}
                                                className="border-t border-zinc-800/50 bg-black overflow-hidden"
                                            >
                                                <div className="p-4 max-h-48 overflow-y-auto font-mono text-[11px] text-zinc-500 space-y-1.5 custom-scrollbar">
                                                    {pipelineLogs.map((log, i) => (
                                                        <div key={i} className="flex gap-3">
                                                            <span className="text-zinc-700 select-none shrink-0">{`[${(i + 1).toString().padStart(2, "0")}]`}</span>
                                                            <span className="break-all">{log}</span>
                                                        </div>
                                                    ))}
                                                    <div ref={logScrollRef} />
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                    <div ref={scrollRef} />
                </div>
            </div>

            {/* Input Overlay */}
            <div className="w-full bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a] to-transparent pt-10 pb-6 px-4 absolute bottom-0 z-20">
                <div className="max-w-3xl mx-auto relative group">
                    <AnimatePresence>
                        {mediaPreview && (
                            <motion.div
                                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, scale: 0.95 }}
                                className="absolute bottom-full mb-3 left-0 p-2 bg-zinc-900 rounded-lg flex items-center border border-zinc-800 select-none shadow-xl"
                            >
                                <div className="relative w-12 h-12 rounded overflow-hidden shrink-0 bg-black border border-zinc-800">
                                    {selectedMedia?.type.startsWith("video/") ? (
                                        <Video className="w-5 h-5 m-auto mt-3 text-zinc-500" />
                                    ) : selectedMedia?.type.startsWith("audio/") ? (
                                        <Music className="w-5 h-5 m-auto mt-3 text-zinc-500" />
                                    ) : (
                                        <img src={mediaPreview} className="w-full h-full object-cover" alt="preview" />
                                    )}
                                </div>
                                <div className="ml-3 mr-6 flex flex-col justify-center max-w-[120px]">
                                    <span className="text-xs truncate font-medium text-zinc-200">{selectedMedia?.name}</span>
                                    <span className="text-[10px] text-zinc-500">{(selectedMedia!.size / 1024 / 1024).toFixed(2)} MB</span>
                                </div>
                                <button
                                    onClick={removeMedia}
                                    className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-zinc-700 text-white flex items-center justify-center hover:bg-zinc-600 border border-zinc-800"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <div className="relative rounded-2xl bg-zinc-900 border border-zinc-800 transition-all focus-within:border-zinc-600 focus-within:shadow-sm">
                        <input
                            type="file"
                            className="hidden"
                            ref={fileInputRef}
                            accept="image/*,video/*,audio/*"
                            onChange={handleMediaSelect}
                        />

                        <Textarea
                            placeholder="Describe what you want to generate or analyze..."
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            className="min-h-[52px] max-h-[200px] w-full resize-none bg-transparent border-0 focus-visible:ring-0 px-4 py-3.5 pb-12 text-[15px] font-normal leading-relaxed text-zinc-100 placeholder:text-zinc-500"
                            rows={1}
                        />

                        <div className="absolute left-2.5 bottom-2.5 flex items-center gap-1">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <Paperclip className="w-4 h-4" />
                            </Button>
                        </div>

                        <div className="absolute right-2.5 bottom-2.5">
                            <Button
                                onClick={handleSubmit}
                                disabled={isLoading || (!input.trim() && !selectedMedia)}
                                className="h-8 w-8 p-0 rounded-lg bg-white hover:bg-zinc-200 disabled:opacity-30 disabled:bg-zinc-600 transition-all text-black flex items-center justify-center"
                            >
                                <Send className="w-4 h-4" />
                            </Button>
                        </div>
                    </div>

                    <div className="text-center mt-3 text-[10px] text-zinc-600 font-medium tracking-wide">
                        AutoGenie may make mistakes. Verify important metadata from the semantic map.
                    </div>
                </div>
            </div>
        </div>
    );
}
