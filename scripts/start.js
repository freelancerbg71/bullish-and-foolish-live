if (!process.env.DATA_USER_AGENT) {
  process.env.DATA_USER_AGENT = "BullishAndFoolish/1.0 (freelancer.bg@gmail.com)";
}

await import("../server.js");
