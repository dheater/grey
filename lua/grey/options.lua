local models = require("grey.models")

local M = {}

function M.build_env()
	return {
		CLAUDE_CODE_USE_BEDROCK = "1",
		AWS_REGION = "us-east-1",
		ANTHROPIC_DEFAULT_HAIKU_MODEL = models.BEDROCK_MODEL_IDS["haiku5.5"],
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1",
	}
end

M.READ_TOOLS = { "Read", "Glob", "Grep" }

function M.build_argv(opts)
	local tools = table.concat(M.READ_TOOLS, ",")
	local argv = {
		"claude",
		"-p",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--tools",
		tools,
		"--allowed-tools",
		tools,
		"--permission-mode",
		"dontAsk", -- Noone can answer a question mid-run with grey.
		"--setting-sources",
		"project", -- Read only the project files. Not ~/.claude, etc...
		"--no-session-persistence", -- Do not save to disk. No resume.
		'{"includeGitInstructions":false}', -- Git is blocked
		"--system-prompt",
		opts.persona, -- Grey's persona
		"--model",
		opts.model_id,
	}

	assert(opts.effort)
	if opts.effort ~= "default" then
		vim.list_extend(argv, { "--effort", opts.effort })
	end

	return argv
end

return M
