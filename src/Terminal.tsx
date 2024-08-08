import React from "react";

type TerminalProps = {
  peerId: string;
  messages: string[];
  isProcessing: boolean;
  keyDownEvent: (e: React.KeyboardEvent<HTMLInputElement>) => void;
};

const Terminal: React.FC<TerminalProps> = ({
  peerId,
  messages,
  isProcessing,
  keyDownEvent,
}) => {
  return (
    <div className="terminal">
      <div className="message">
        {messages.map((msg, index) => (
          <div key={index}>{msg}</div>
        ))}
      </div>
      <div className="command">
        <span>
          {peerId}
          {"> "}
        </span>
        <input
          className="command-input"
          type="text"
          onKeyDown={keyDownEvent}
          disabled={isProcessing}
        />
      </div>
    </div>
  );
};

export default Terminal;
