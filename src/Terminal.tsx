import React from "react";

type TerminalProps = {
  peerId: string;
  messages: string[];
  isProcessing: boolean;
  keyDownEvent: (e: React.KeyboardEvent<HTMLInputElement>) => void;
};

const Terminal: React.FC<TerminalProps> = ({ peerId, messages, isProcessing, keyDownEvent }) => {
  return (
    <div className="terminal">
      <div>
        <div className="message">
          {messages.map((msg, index) => (
            <div key={index}>{msg}</div>
          ))}
        </div>
        <div className="command">
          <label>
            {peerId}
            {"> "}
          </label>
          <input
            className="command-input"
            type="text"
            onKeyDown={keyDownEvent}
            disabled={isProcessing}
          />
        </div>
      </div>
    </div>
  );
};

export default Terminal;
