import { describe, expect, it } from "vitest";
import type { AgentJobView, AgentStatusView } from "../../shared/protocol";
import { clientReducer, initialState } from "../../web/src/state";

const pi: AgentStatusView = {
	id: "pi",
	label: "pi",
	command: "pi",
	npmPackage: "@mariozechner/pi-coding-agent",
	installed: false,
	onPath: false,
	path: null,
	version: null,
	error: null,
	robBackend: true,
	needsProviderAndModel: true,
	robBlockedReason: "",
	testedVersion: "0.73.0",
	job: null,
};

const job: AgentJobView = {
	id: "job_1",
	agent: "pi",
	phase: "installing",
	detail: "npm notice hi",
	error: null,
};

describe("agent state", () => {
	it("loads the agent list from the agents_loaded action", () => {
		const state = clientReducer(initialState(), {
			type: "agents_loaded",
			agents: [pi],
		});
		expect(state.agents).toEqual([pi]);
	});

	it("replaces the list on the agents server event", () => {
		const state = clientReducer(initialState(), {
			type: "server",
			event: { type: "agents", agents: [pi] },
		});
		expect(state.agents).toEqual([pi]);
	});

	it("keeps the latest job per agent from agent_job events", () => {
		const installing = clientReducer(initialState(), {
			type: "server",
			event: { type: "agent_job", job },
		});
		expect(installing.agentJobs.pi).toEqual(job);

		const installed: AgentJobView = {
			...job,
			id: "job_2",
			phase: "installed",
			detail: "installed 0.73.0 at /usr/local/bin/pi",
		};
		const done = clientReducer(installing, {
			type: "server",
			event: { type: "agent_job", job: installed },
		});
		expect(done.agentJobs.pi).toEqual(installed);

		const other: AgentJobView = { ...job, id: "job_3", agent: "codex" };
		const both = clientReducer(done, {
			type: "server",
			event: { type: "agent_job", job: other },
		});
		expect(Object.keys(both.agentJobs).sort()).toEqual(["codex", "pi"]);
		expect(both.agentJobs.pi).toEqual(installed);
	});
});
