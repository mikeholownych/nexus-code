import { ToolCall } from "../types.js";
import { type ExecutionReceipt } from "./spine.js";
import { admitToolCall, afterToolCall, confirmToolCall, decideToolCall, executeToolCall, parseToolArguments } from "./tool_pipeline.js";
import type { ConfirmHandler } from "./agent_support.js";

export async function dispatchToolCallImpl(this: any, call: ToolCall,
    currentStep: number,
    actor: "agent" | "subagent" = "agent",
    onConfirm?: ConfirmHandler): Promise<{ receipt: ExecutionReceipt; shouldExit: boolean }> {
  const toolName = call.function.name;
  const { args: parsedArgs, structurallyRepaired } = parseToolArguments(call);
  const admitted = admitToolCall.call(this, call, currentStep, actor, toolName, parsedArgs, structurallyRepaired);
  if ("receipt" in admitted) return admitted;
  let args = admitted.args;

  const skillAttr = () => this.skillActivations?.attribution?.() ?? {};
  const recordReceipt = (receipt: ExecutionReceipt) => {
    this.lastToolReceipts = [...(this.lastToolReceipts || []), receipt].slice(-32);
    return receipt;
  };

  this.ui.printToolCall(toolName, args);
  const dispatch = ++this.toolDispatchSeq;
  this.observer?.onToolStart?.({ dispatch, callId: call.id, tool: toolName, args });
  const subject = String(args.path ?? args.file_path ?? args.command ?? args.url ?? args.query ?? "").replace(/\s+/g, " ").slice(0, 120);
  this.activity("tool", { tool: toolName, ...(subject ? { subject } : {}) });

  const decision = decideToolCall.call(this, {
    call, currentStep, actor, onConfirm, toolName, args, dispatch, subject, skillAttr, recordReceipt,
  });
  if ("receipt" in decision) return decision;
  const approval = "ask" in decision
    ? await confirmToolCall.call(this, decision.ask)
    : decision;
  if ("receipt" in approval) return approval;
  const state = approval.run;
  const { verificationAuthority, reissuesInterrupted } = state;
  const execution = await executeToolCall(this, {
    call: state.call,
    currentStep: state.currentStep,
    actor: state.actor,
    onConfirm: state.onConfirm,
    toolName: state.toolName,
    args: state.args,
    dispatch: state.dispatch,
    verificationAuthority: state.verificationAuthority,
    reissuesInterrupted: state.reissuesInterrupted,
    skillAttr: state.skillAttr,
    recordReceipt: state.recordReceipt,
  });
  return afterToolCall(this, execution);
}

