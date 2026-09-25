import Head from "next/head";

export default function Home() {
  return (
    <>
      <Head>
        <title>Next.js App</title>
        <meta name="description" content="A fresh Next.js workspace" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          background: "#ffffff",
          color: "#111",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            background: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "2rem",
            color: "#fff",
            fontWeight: 700,
            marginBottom: "1.5rem",
          }}
        >
          N
        </div>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "2rem", fontWeight: 700 }}>
          Welcome to Next.js
        </h1>
        <p
          style={{
            margin: "0 0 2rem",
            fontSize: "1.05rem",
            color: "#666",
            textAlign: "center",
            maxWidth: "32rem",
          }}
        >
          This is a fresh workspace. Edit <code style={{ background: "#f3f3f3", padding: "0.1rem 0.35rem", borderRadius: 4 }}>pages/index.tsx</code>{" "}
          and save — the preview updates instantly inside the WebContainer.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1rem",
            width: "100%",
            maxWidth: "44rem",
          }}
        >
          {[
            { title: "Pages Router", body: "This template uses the Pages Router with static export." },
            { title: "React 19", body: "Built on the latest React and Next.js." },
            { title: "Edit anything", body: "Use the chat agent to describe changes and build your app." },
          ].map((card) => (
            <div
              key={card.title}
              style={{
                border: "1px solid #eee",
                borderRadius: 12,
                padding: "1.25rem",
                background: "#fafafa",
              }}
            >
              <h2 style={{ margin: "0 0 0.4rem", fontSize: "1rem", fontWeight: 600 }}>
                {card.title}
              </h2>
              <p style={{ margin: 0, fontSize: "0.9rem", color: "#666", lineHeight: 1.5 }}>
                {card.body}
              </p>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
