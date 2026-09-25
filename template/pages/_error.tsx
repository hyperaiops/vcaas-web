import type { NextApiResponse } from "next";

function ErrorPage({ statusCode }: { statusCode?: number }) {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "3rem" }}>{statusCode ?? "Error"}</h1>
      <p style={{ margin: 0, color: "#666" }}>
        {statusCode
          ? `An error ${statusCode} occurred on the server`
          : "An error occurred on the client"}
      </p>
    </main>
  );
}

ErrorPage.getInitialProps = ({
  res,
  err,
}: {
  res?: NextApiResponse;
  err?: { statusCode?: number };
}) => {
  const statusCode = res ? res.statusCode : err ? err.statusCode ?? 404 : 404;
  return { statusCode };
};

export default ErrorPage;
