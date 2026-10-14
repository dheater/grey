local Recorder = require("grey.recorder")
local models = require("grey.models")

local SONNET = models.BEDROCK_MODEL_IDS["sonnet5.5"]
local OPUS = models.BEDROCK_MODEL_IDS["opus5.5"]

local function success(text, model_usage)
	return { type = "result", subtype = "success", is_error = false, result = text, modelUsage = model_usage }
end

local function eq(actual, expected)
	assert(actual == expected, ("expected: %s\nactual:    %s"):format(vim.inspect(expected), vim.inspect(actual)))
end

local M = {}

M["subtracts its baseline per model"] = function()
	local totals = {
		[SONNET] = { inputTokens = 130, outputTokens = 14 },
		[OPUS] = { inputTokens = 50, outputTokens = 5 },
	}

	local rec = Recorder.new({
		model_id = OPUS,
		baseline = {
			[SONNET] = { inputTokens = 100, outputTokens = 10 },
			[OPUS] = { inputTokens = 20, outputTokens = 2 },
		},
	})

	rec:record(success("ok", totals))
	local usage = rec:usage()
	eq(usage.inputTokens, 60)
	eq(usage.outputTokens, 7)
	eq(rec:result_model_usage(), totals)
end

M["keeps the old baseline when the turn has no result"] = function()
	local baseline = { [OPUS] = { inputTokens = 20 } }
	local rec = Recorder.new({ model_id = OPUS, baseline = baseline })
	eq(rec:result_model_usage(), baseline)
end

return M
