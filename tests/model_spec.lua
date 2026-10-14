local models = require("grey.models")

local M = {}

M["BEDROCK_MODEL_IDS maps each alias to its us. inference profile"] = function()
	assert(vim.deep_equal(models.BEDROCK_MODEL_IDS, {
		["sonnet5.5"] = "us.anthropic.claude-sonnet-5-5",
		["haiku5.5"] = "us.anthropic.claude-haiku-5-5",
		["opus5.5"] = "us.anthropic.claude-opus-5-5",
	}))
end

return M
