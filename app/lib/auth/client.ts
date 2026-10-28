"use client";

export async function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status === 401) {
    const returnTo = window.location.pathname + window.location.search;
    const login = new URL("/auth/login", window.location.origin);
    login.searchParams.set("returnTo", returnTo);
    window.location.assign(login.href);
    throw new Error("登录已过期，请重新登录。");
  }
  return response;
}
