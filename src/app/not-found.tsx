export default function NotFound() {
  return (
    <main className="auth" id="main">
      <div className="auth-card">
        <h1>Page not found</h1>
        <p className="muted">That page doesn't exist or you don't have access to it.</p>
        <p><a className="btn" href="/">Go to my dashboard</a></p>
      </div>
    </main>
  );
}
