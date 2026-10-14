local M = {}

-- grey's model aliases mapped to Bedrock ids.
--
-- The ids are `us.`prefexed inference profiles because a bare `anthropic.*`
-- id has no on-demand throughput on Bedrock and cannot be invoked. The
-- prefix names a cross-region profile, priced at the in-region rate with no
-- transfer fee.
M.BEDROCK_MODEL_IDS = {
	["opus5.5"] = "us.anthropic.claude-opus-5-5",
	["sonnet5.5"] = "us.anthropic.claude-sonnet-5-5",
	["haiku5.5"] = "us.anthropic.claude-haiku-5-5",
}

function M.is_model_alias(s)
	return M.BEDROCK_MODEL_IDS[s] ~= nil
end

-- Effort strings from the model cards. `default` sends no effort, so the model
-- uses its own default, which is adaptive thinking where the model has it.
M.EFFORT_LEVELS = { "default", "low", "medium", "high", "xhigh", "max" }

function M.is_effort_level(v)
	return vim.list_contains(M.EFFORT_LEVELS, v)
end

return M
