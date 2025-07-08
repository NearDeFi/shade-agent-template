import "../styles/globals.css";

export default function Overlay({ message }) {
  if (!message) return [];

  return (
    <div className="overlay">
      <div className="message">
        {message.text}
        {!message.success && (
          <div className="spinnerContainer">
            <img
              src="/shade-agent.svg"
              alt="Loading..."
              className="spinningLogo"
            />
          </div>
        )}
      </div>
    </div>
  );
}
