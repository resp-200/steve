/**
 * The tool contract the functional layer hands to the layers above.
 *
 * Protocol layers may declare tools, but they do so through this module, so
 * they never import a pi package directly.
 */
export { Type, type Static } from "@earendil-works/pi-ai";
export type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
