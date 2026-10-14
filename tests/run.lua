local root = vim.fn.fnamemodify(arg[0], ":p:h:h")
vim.opt.runtimepath:prepend(root)

local files = vim.fn.glob(root .. "/tests/*_spec.lua", false, true)
if #files == 0 then
	io.write("no specs found in ", root, "/tests\n")
	os.exit(1)
end

local passed, failed = 0, 0
for _, path in ipairs(files) do
	local file = vim.fn.fnamemodify(path, ":t")
	local ok, spec = pcall(dofile, path)
	if ok and type(spec) ~= "table" then
		ok, spec = false, file .. " must return a table of name to function"
	end
	if not ok then
		failed = failed + 1
		io.write("FAIL ", file, " (load)\n  ", tostring(spec), "\n")
	else
		local names = vim.tbl_keys(spec)
		table.sort(names)
		for _, name in ipairs(names) do
			local test_ok, err = pcall(spec[name])
			if test_ok then
				passed = passed + 1
			else
				failed = failed + 1
				io.write("FAIL ", file, " ", name, "\n  ", tostring(err), "\n")
			end
		end
	end
end

io.write(passed, " passed ", failed, " failed\n")
if failed > 0 then
	os.exit(1)
end
