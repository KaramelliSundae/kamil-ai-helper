package expo.modules.mailsocket

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

private const val READ_BYTES = 65536
private const val MAX_PLAIN_LINE = 2048

/**
 * A TLS connection to a mail server and nothing else. Sending mail on port 587 starts in the clear, so that opening happens
 * here and JavaScript only ever gets the socket once it is encrypted. There is no way to turn off the checks: the certificate must be trusted by
 * Android and must name the server, because the student's password goes through here. Bytes cross to JavaScript as ISO-8859-1
 * strings, one character per byte. Everything runs off the shared module thread, so a slow server holds up nothing else.
 */
class MailSocketModule : Module() {
  private val sockets = ConcurrentHashMap<Int, SSLSocket>()
  private val nextHandle = AtomicInteger(1)

  private fun socket(handle: Int): SSLSocket =
    sockets[handle] ?: throw CodedException("ERR_MAIL_CLOSED", "Mail connection is closed", null)

  /** The checks that must not be skipped: the certificate is trusted by Android and names this server. */
  private fun secure(plain: Socket, host: String, port: Int): Int {
    val factory = SSLSocketFactory.getDefault() as SSLSocketFactory
    val socket = factory.createSocket(plain, host, port, true) as SSLSocket
    socket.sslParameters = socket.sslParameters.apply { endpointIdentificationAlgorithm = "HTTPS" }
    socket.startHandshake()
    if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, socket.session)) {
      throw CodedException("ERR_MAIL_CERTIFICATE", "The certificate does not name this server", null)
    }
    val handle = nextHandle.getAndIncrement()
    sockets[handle] = socket
    return handle
  }

  /**
   * One SMTP reply in the clear, a byte at a time: nothing is read ahead, so text a stranger on the network slips in before
   * the handshake cannot end up looking as if it came over TLS.
   */
  private fun plainReply(socket: Socket): Pair<Int, String> {
    val input = socket.getInputStream()
    val all = StringBuilder()
    while (true) {
      val line = StringBuilder()
      while (true) {
        val byte = input.read()
        if (byte < 0) throw CodedException("ERR_MAIL_CLOSED", "The server closed the connection", null)
        if (byte == 10) break
        if (byte != 13) line.append(byte.toChar())
        if (line.length > MAX_PLAIN_LINE) throw CodedException("ERR_MAIL_NO_TLS", "Unexpected reply", null)
      }
      all.append(line).append('\n')
      if (line.length < 3) throw CodedException("ERR_MAIL_NO_TLS", "Unexpected reply", null)
      if (line.length == 3 || line[3] == ' ') {
        return Pair(line.substring(0, 3).toIntOrNull() ?: 0, all.toString())
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("MailSocket")

    // No password or mail goes through here: only what it takes to ask for encryption. A server that does not offer it is refused.
    AsyncFunction("openStartTls") Coroutine { host: String, port: Int, timeoutMs: Int ->
      withContext(Dispatchers.IO) {
        val plain = Socket()
        try {
          plain.connect(InetSocketAddress(host, port), timeoutMs)
          plain.soTimeout = timeoutMs
          val output = plain.getOutputStream()
          val noTls = { CodedException("ERR_MAIL_NO_TLS", "The server does not offer encryption", null) }
          if (plainReply(plain).first != 220) throw noTls()
          output.write("EHLO kamil\r\n".toByteArray(Charsets.US_ASCII))
          output.flush()
          val hello = plainReply(plain)
          if (hello.first != 250 || !hello.second.uppercase().contains("STARTTLS")) throw noTls()
          output.write("STARTTLS\r\n".toByteArray(Charsets.US_ASCII))
          output.flush()
          if (plainReply(plain).first != 220) throw noTls()
          secure(plain, host, port)
        } catch (error: Exception) {
          plain.close()
          throw error
        }
      }
    }

    AsyncFunction("open") Coroutine { host: String, port: Int, timeoutMs: Int ->
      withContext(Dispatchers.IO) {
        val plain = Socket()
        try {
          plain.connect(InetSocketAddress(host, port), timeoutMs)
          plain.soTimeout = timeoutMs
          secure(plain, host, port)
        } catch (error: Exception) {
          plain.close()
          throw error
        }
      }
    }

    AsyncFunction("write") Coroutine { handle: Int, data: String ->
      withContext(Dispatchers.IO) {
        val output = socket(handle).outputStream
        output.write(data.toByteArray(Charsets.ISO_8859_1))
        output.flush()
      }
    }

    // An empty string means the server closed the connection.
    AsyncFunction("read") Coroutine { handle: Int ->
      withContext(Dispatchers.IO) {
        val buffer = ByteArray(READ_BYTES)
        val count = socket(handle).inputStream.read(buffer)
        if (count < 0) "" else String(buffer, 0, count, Charsets.ISO_8859_1)
      }
    }

    AsyncFunction("close") Coroutine { handle: Int ->
      withContext(Dispatchers.IO) {
        sockets.remove(handle)?.close()
        Unit
      }
    }

    OnDestroy {
      sockets.values.forEach { runCatching { it.close() } }
      sockets.clear()
    }
  }
}
