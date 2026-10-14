local USAGE_SOURCE = "claude-bedrock"

local function nonzero(n)
	if n ~= nil and n ~= 0 then
		return n
	end
end

local function prompt_tokens(turn)
	return (turn.inputTokens or 0) + (turn.cacheReadTokens or 0) + (turn.cacheWriteTokens or 0)
end

local Recorder = {}
Recorder.__index = Recorder

function Recorder.new(opts)
	return setmetatable({
		model_id = opts.model_id,
		baseline = opts.baseline or {},
		on_progress = opts.on_progress or function() end,
		on_tool_call = opts.on_tool_call or function() end,
		now = opts.now or vim.uv.now,
		pending = {},
		requests = {},
		request_ids = {},
		compactions = 0,
		result = nil,
	}, Recorder)
end

function Recorder:record(msg)
	if msg.type == "result" then
		self.result = msg
	end
end

function Recorder:usage(latency_ms)
	local turns = {}
	for _, id in ipairs(self.request_ids) do
		turns[#turns + 1] = self.requests[id]
	end

	-- A turn with no result has only the per-request counts.
	local model_usage = self.result and self.result.modelUsage
	local totals = {}
	if model_usage then
		for model, m in pairs(model_usage) do
			local b = self.baseline[model] or {}
			totals[#totals + 1] = {
				inputTokens = (m.inputTokens or 0) - (b.inputTokens or 0),
				outputTokens = (m.outputTokens or 0) - (b.outputTokens or 0),
				cacheReadTokens = (m.cacheReadTokens or 0) - (b.cacheReadTokens or 0),
				cacheWriteTokens = (m.cacheWriteTokens or 0) - (b.cacheWriteTokens or 0),
			}
		end
	end

	local function total(key)
		local n = 0
		for _, t in ipairs(totals) do
			n = n + (t[key] or 0)
		end
		return n
	end

	local usage = {
		source = USAGE_SOURCE,
		modelId = self.model_id,
		turns = #turns,
		inputTokens = nonzero(total("inputTokens")),
		outputTokens = nonzero(total("outputTokens")),
		cacheReadTokens = nonzero(total("cacheReadTokens")),
		cacheWriteTokens = nonzero(total("cacheWriteTokens")),
		compactions = self.compactions,
		latencyMs = latency_ms,
	}
	if #turns > 0 then
		usage.firstTurn = turns[1]
		usage.turnPromptTokens = vim.tbl_map(prompt_tokens, turns)
	end

	return usage
end

function Recorder:result_model_usage()
	return self.result and self.result.modelUsage or self.baseline
end

return Recorder
