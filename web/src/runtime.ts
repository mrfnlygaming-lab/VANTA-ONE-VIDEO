export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type Transport = <T>(path: string, options?: RequestInit) => Promise<T>;

export const runtime = {
  standalone: false,
  exampleImage: "/sample-scene.svg",
};

let transport: Transport | undefined;

export function configureRuntime(
  options: typeof runtime & { request: Transport },
) {
  runtime.standalone = options.standalone;
  runtime.exampleImage = options.exampleImage;
  transport = options.request;
}

export async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  if (transport) return transport<T>(path, options);
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      body.error || "Something went wrong. Please try again.",
      response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
