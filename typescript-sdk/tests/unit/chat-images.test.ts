import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient, type ChatCreateRequest } from "../../src/index.js";

const AGENT_ID = "1f0e0c7c-2b8e-4a55-8e3b-7d8f7f0c8a11";
const IMAGE_ID = "6c3e9f2a-1d4b-4b8e-9f0a-2a4c6e8b0d12";

const respondingWith = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("chat images", () => {
  it("uploads an image as multipart for an agent, and returns its id and reading status", async () => {
    const fetchMock = respondingWith(201, { id: IMAGE_ID, readingStatus: "read" });
    const client = createRadiosoClient({ baseUrl: "https://api.example.com", apiToken: "token-123", fetch: fetchMock });

    const uploaded = await client.chat.uploadImage({
      agentId: AGENT_ID,
      image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      mimeType: "image/jpeg",
      locale: "it",
    });

    expect(uploaded).toEqual({ id: IMAGE_ID, readingStatus: "read" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.example.com/api/v1/assistant/images?agentId=${AGENT_ID}`);
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const image = form.get("image") as File;
    expect(image.type).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    expect(form.get("locale")).toBe("it");
    // The browser sets the multipart boundary itself.
    expect(new Headers(init?.headers).get("content-type")).toBeNull();
  });

  it("sends a message with images, and images alone", async () => {
    const fetchMock = respondingWith(200, { conversationId: "c-1", answer: "Found two like it." });
    const client = createRadiosoClient({ baseUrl: "https://api.example.com", apiToken: "token-123", fetch: fetchMock });
    const imagesOnly: ChatCreateRequest = { agentId: AGENT_ID, imageIds: [IMAGE_ID] };

    await client.chat.create({ agentId: AGENT_ID, message: "Something like this", imageIds: [IMAGE_ID] });
    await client.chat.create(imagesOnly);

    const sentBody = (call: number): unknown => JSON.parse(fetchMock.mock.calls[call][1]?.body as string);
    expect(sentBody(0)).toMatchObject({ agentId: AGENT_ID, message: "Something like this", imageIds: [IMAGE_ID] });
    expect(sentBody(1)).toMatchObject({ agentId: AGENT_ID, imageIds: [IMAGE_ID] });
  });

  it("surfaces an upload the agent refuses as an error with its code", async () => {
    const fetchMock = respondingWith(415, { error: { code: "unsupported_image_type", message: "Send a JPEG, PNG or WebP image." } });
    const client = createRadiosoClient({ baseUrl: "https://api.example.com", apiToken: "token-123", fetch: fetchMock });

    await expect(client.chat.uploadImage({ agentId: AGENT_ID, image: new Blob(["GIF89a"]) })).rejects.toMatchObject({ status: 415, code: "unsupported_image_type" });
  });
});
