import { jest } from "@jest/globals";
import { createPinnedLookup } from "../../modules/webhooks/webhook-request.js";

describe("pinned webhook DNS lookup", () => {
  it("uses only the address already validated, including for all-address lookups", () => {
    const lookup = createPinnedLookup({
      address: "93.184.216.34",
      family: 4,
    });
    const callback = jest.fn();

    lookup("rebind.example", {}, callback);

    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("returns only the pinned address when the request asks for all addresses", () => {
    const lookup = createPinnedLookup({
      address: "93.184.216.34",
      family: 4,
    });
    const callback = jest.fn();

    lookup("rebind.example", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [
      { address: "93.184.216.34", family: 4 },
    ]);
  });
});
