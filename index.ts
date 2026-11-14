import { Spectrum } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";

// Step 1: echo bot on the terminal provider (no Photon account needed).
const app = await Spectrum({ providers: [terminal.config()] });

process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});

for await (const [space, message] of app.messages) {
  if (message.content.type !== "text") continue;
  const text = message.content.text;
  await space.responding(async () => {
    await message.reply(`echo: ${text}`);
  });
}
