declare const GREY_VERSION: string;

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log(GREY_VERSION);
  process.exit(0);
}
