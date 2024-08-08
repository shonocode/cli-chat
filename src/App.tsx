import PWABadge from "./PWABadge.tsx";
import Terminal from "./Terminal.tsx";
import { useState, useEffect } from "react";
import Peer, { DataConnection } from "peerjs";
import "./App.css";
import {
  OFFLINE,
  ONLINE,
  LOGGED_IN,
  CONNECTING,
  CONNECTED,
  CLI_CHAT,
  CLI_CHAT_AA,
} from "./consts.ts";

const App = () => {
  const [status, setStatus] = useState<number>(OFFLINE);
  const [peerId, setPeerId] = useState<string>("");
  const [peer, setPeer] = useState<Peer | null>(null);
  const [conn, setConn] = useState<DataConnection | null>(null);
  const [pendingConnection, setPendingConnection] =
    useState<DataConnection | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  useEffect(() => {
    setMessages([CLI_CHAT_AA]);
    addTerminal(
      CLI_CHAT,
      "Welcome to CLI-CHAT. Type 'help' to see the list of commands."
    );
    if (navigator.onLine) {
      setStatus(ONLINE);
    }
  }, []);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const command = e.currentTarget.value;
      addTerminal(peerId, command);
      runCommand(command);
      e.currentTarget.value = "";
    }
  };

  const runCommand = (command: string) => {
    const [action, ...args] = command.split(" ");
    if (!isAllowedAction(action)) {
      addTerminal(CLI_CHAT, "Invalid command or incorrect status.");
      return;
    }
    switch (action) {
      case "login":
        handleLoginCommand(args);
        break;
      case "connect":
        handleConnectCommand(args);
        break;
      case "disconnect":
        handleDisconnectCommand();
        break;
      case "logout":
        handleLogoutCommand();
        break;
      case "help":
        handleHelpCommand();
        break;
      case "log":
        handleLogCommand(args);
        break;
      case "loglist":
        handleLogListCommand();
        break;
      case "logdelete":
        handleLogDeleteCommand(args);
        break;
      default:
        handleDefaultCommand(action, command);
        break;
    }
  };

  const isAllowedAction = (action: string): boolean => {
    switch (action) {
      case "login":
        return status === ONLINE;
      case "connect":
        return status === LOGGED_IN;
      case "disconnect":
        return status === CONNECTED;
      case "logout":
        return status === LOGGED_IN || status === CONNECTED;
      case "help":
      case "log":
      case "loglist":
      case "logdelete":
        return true;
      default:
        return false;
    }
  };

  const handleLoginCommand = (args: string[]) => {
    const id = args[0] || "";
    initializePeer(id);
  };

  const handleConnectCommand = (args: string[]) => {
    const id = args[0];
    id ? connectToPeer(id) : addTerminal(CLI_CHAT, "Need a destination ID.");
  };

  const handleDisconnectCommand = () => {
    if (conn) {
      conn.close();
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, "Disconnected.");
    }
  };

  const handleLogoutCommand = () => {
    peer?.destroy();
    setStatus(ONLINE);
    setPeer(null);
    setPeerId("");
    addTerminal(CLI_CHAT, "Logged out.");
  };

  const handleLogCommand = (args: string[]) => {
    const dateTime = args[0] || "";
    if (!dateTime) {
      addTerminal(CLI_CHAT, "Usage: log <dateTime> (e.g., log 2024-12-01)");
      return;
    }
    const log = getLog(dateTime);
    log
      ? addTerminal("", log)
      : addTerminal(CLI_CHAT, "No logs found for the specified date.");
  };

  const handleLogListCommand = () => {
    const keys = getAllLogKeys();
    keys.length > 0
      ? keys.forEach((key) => addTerminal(CLI_CHAT, key))
      : addTerminal(CLI_CHAT, "No logs found.");
  };

  const handleLogDeleteCommand = (args: string[]) => {
    const option = args[0] || "";

    if (option === "all") {
      localStorage.clear();
      addTerminal(CLI_CHAT, "All logs have been deleted.");
    } else {
      const dateTime = option;
      if (!dateTime) {
        addTerminal(
          CLI_CHAT,
          "Usage: logdelete <dateTime> (e.g., logdelete 2025-07-05) or logdelete all"
        );
        return;
      }

      if (localStorage.getItem(dateTime)) {
        localStorage.removeItem(dateTime);
        addTerminal(CLI_CHAT, `Log for ${dateTime} has been deleted.`);
      } else {
        addTerminal(CLI_CHAT, "No logs found for the specified date.");
      }
    }
  };

  const handleHelpCommand = () => {
    addTerminal(
      CLI_CHAT,
      "Commands: login, connect, disconnect, logout, help, log <date>, loglist"
    );
  };

  const handleDefaultCommand = (action: string, command: string) => {
    if (status === CONNECTING) {
      confirmConnect(action);
    } else if (status === CONNECTED) {
      sendMessage(command);
    }
  };

  const initializePeer = (id: string) => {
    setIsProcessing(true);
    const peer = new Peer(id);
    setPeer(peer);

    peer.on("open", (id) => {
      setPeerId(id);
      setStatus(LOGGED_IN);
      addTerminal(CLI_CHAT, `Your ID has been set to ${id}`);
      setIsProcessing(false);
    });

    peer.on("connection", (connection) => {
      connection.on("open", () => {
        setStatus(CONNECTING);
        setPendingConnection(connection);
        addTerminal(
          CLI_CHAT,
          `${connection.peer} wants to connect. Do you accept? (y/n)`
        );
      });
    });

    peer.on("disconnected", () => {
      setStatus(ONLINE);
      addTerminal(CLI_CHAT, "Disconnected.");
    });

    peer.on("close", () => {
      setStatus(ONLINE);
      addTerminal(CLI_CHAT, "Logged out.");
    });

    peer.on("error", (err) => {
      addTerminal(CLI_CHAT, err.message);
      setIsProcessing(false);
    });
  };

  const connectToPeer = (destinationPeerId: string) => {
    if (peer) {
      const connection = peer.connect(destinationPeerId);

      connection.on("open", () => {
        setStatus(CONNECTED);
        setConn(connection);
        addTerminal(CLI_CHAT, `Connecting to ${destinationPeerId} ...`);

        connection.on("data", (data) => {
          addTerminal(connection.peer, data as string);
          saveLog(connection.peer, data as string);
        });
      });

      connection.on("error", (err) => {
        setStatus(LOGGED_IN);
        addTerminal(
          CLI_CHAT,
          `Error connecting to ${destinationPeerId}: ${err.message}`
        );
      });

      connection.on("close", () => {
        setStatus(LOGGED_IN);
        addTerminal(CLI_CHAT, `Connection to ${destinationPeerId} closed.`);
      });
    }
  };

  const confirmConnect = (response: string) => {
    if (!pendingConnection) return;

    const connection = pendingConnection;

    if (response === "y") {
      setStatus(CONNECTED);
      setConn(connection);
      connection.on("data", (data) => {
        addTerminal(connection.peer, data as string);
        saveLog(connection.peer, data as string);
      });

      connection.on("error", (err) => {
        setStatus(LOGGED_IN);
        addTerminal(
          CLI_CHAT,
          `Error connecting to ${connection.peer}: ${err.message}`
        );
      });

      connection.on("close", () => {
        setStatus(LOGGED_IN);
        addTerminal(CLI_CHAT, `Connection to ${connection.peer} closed.`);
      });

      connection.send(`${peerId} is connected with you.`);
      addTerminal(CLI_CHAT, `Connected to ${connection.peer}.`);
      setPendingConnection(null);
    } else if (response === "n") {
      connection.close();
      setStatus(LOGGED_IN);
      setPendingConnection(null);
      addTerminal(CLI_CHAT, `Connection to ${connection.peer} canceled.`);
    } else {
      addTerminal(CLI_CHAT, "Invalid response. Please enter 'y' or 'n'.");
    }
  };

  const sendMessage = (message: string) => {
    if (conn && conn.open) {
      conn.send(message);
      saveLog(peerId, message);
    }
  };

  const addTerminal = (sender: string, message: string) => {
    setMessages((prevMessages) => [...prevMessages, `${sender}> ${message}\n`]);
  };

  const saveLog = (sender: string, message: string) => {
    const timestamp = new Date();
    const dateKey = `${timestamp.getFullYear()}-${String(
      timestamp.getMonth() + 1
    ).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    const existingLog = localStorage.getItem(dateKey) || "";
    localStorage.setItem(dateKey, `${existingLog}${sender}> ${message}\n`);
  };

  const getLog = (dateKey: string): string | null => {
    return localStorage.getItem(dateKey);
  };

  const getAllLogKeys = (): string[] => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      keys.push(localStorage.key(i) || "");
    }
    return keys;
  };

  return (
    <>
      <div className="crt">
        <Terminal
          peerId={peerId}
          messages={messages}
          isProcessing={isProcessing}
          keyDownEvent={handleInputKeyDown}
        />
      </div>
      <PWABadge />
    </>
  );
};

export default App;
