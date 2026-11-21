import { isIP } from "node:net";

process.env["DATABASE_URL"] ??= "postgresql://localhost:5432/test";
process.env["JWT_SECRET"] ??= "test-secret-not-used-for-signing";
process.env["TIP_SPLITTER_CONTRACT_ID"] ??= `C${"A".repeat(55)}`;
process.env["WEBHOOK_ALLOW_PRIVATE_HOSTS"] = "false";

const {
  assertWebhookDestinationAllowed,
  assertWebhookUrlForRegistration,
  isUnsafeWebhookAddress,
} = await import("../../modules/webhooks/webhook-url.js");

describe("webhook destination validation", () => {
  it.each([
    ["IPv4 loopback", "127.0.0.1"],
    ["IPv4 private 10/8", "10.2.3.4"],
    ["IPv4 private 172.16/12", "172.20.1.1"],
    ["IPv4 private 192.168/16", "192.168.1.2"],
    ["IPv4 link-local", "169.254.169.254"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique-local", "fd12::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["hex IPv4-mapped loopback", "::ffff:7f00:1"],
  ])("rejects %s (%s)", (_label, address) => {
    expect(isIP(address)).not.toBe(0);
    expect(isUnsafeWebhookAddress(address)).toBe(true);
    expect(() =>
      assertWebhookUrlForRegistration(`https://[${address}]/hook`),
    ).toThrow();
  });

  it.each(["localhost", "localhost.", "hooks.localhost"])(
    "rejects local hostname %s",
    (hostname) => {
      expect(() =>
        assertWebhookUrlForRegistration(`https://${hostname}/hook`),
      ).toThrow(/localhost/);
    },
  );

  it("refuses a hostname that resolves to any private address", async () => {
    await expect(
      assertWebhookDestinationAllowed(
        "https://mixed.example/hook",
        async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      ),
    ).rejects.toThrow(/private or reserved/);
  });

  it("refuses a hostname that resolves to no addresses and names the hostname", async () => {
    await expect(
      assertWebhookDestinationAllowed("https://empty.example/hook", async () => []),
    ).rejects.toThrow(/empty\.example.*no addresses/);
  });

  it("allows a public literal address", () => {
    expect(isUnsafeWebhookAddress("93.184.216.34")).toBe(false);
    expect(() =>
      assertWebhookUrlForRegistration("https://93.184.216.34/hook"),
    ).not.toThrow();
  });
});
