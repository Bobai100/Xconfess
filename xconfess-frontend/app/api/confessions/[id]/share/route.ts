import { resolveBackendRoute, getSessionAuthorization } from "@/app/lib/api/proxy";
import { createApiErrorResponse } from "@/lib/apiErrorHandler";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorization = getSessionAuthorization(request);
    const backend = resolveBackendRoute(request, `/confessions/${id}/share`);
    const response = await fetch(backend.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cookie": request.headers.get("cookie") || "",
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createApiErrorResponse(error, { status: 500, route: "POST /api/confessions/[id]/share" });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const authorization = getSessionAuthorization(request);
    const backend = resolveBackendRoute(request, `/confessions/${id}/share`);
    const response = await fetch(backend.url, {
      method: "DELETE",
      headers: {
        "cookie": request.headers.get("cookie") || "",
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    return createApiErrorResponse(error, { status: 500, route: "DELETE /api/confessions/[id]/share" });
  }
}
