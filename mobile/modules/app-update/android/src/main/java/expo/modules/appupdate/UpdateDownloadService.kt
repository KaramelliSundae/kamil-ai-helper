package expo.modules.appupdate

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import kotlinx.coroutines.CompletableDeferred
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

private const val CHANNEL = "app-update"
private const val NOTIFICATION = 41
private const val ACTION_CANCEL = "expo.modules.appupdate.CANCEL"
private const val BUFFER_BYTES = 64 * 1024
private const val REPORT_EVERY_MS = 400L
private const val CONNECT_TIMEOUT_MS = 20_000
private const val READ_TIMEOUT_MS = 30_000

internal class DownloadCancelled : Exception("cancelled")

internal class DownloadJob(
  val url: String,
  val headers: Map<String, String>,
  val target: File,
  val title: String,
  val finished: CompletableDeferred<Unit>,
  val onProgress: (Long, Long) -> Unit,
) {
  @Volatile var cancelled = false
}

/** In memory rather than in an Intent, because a job can carry the token of the student's server. */
internal object CurrentDownload {
  val job = AtomicReference<DownloadJob?>(null)
}

/**
 * A foreground service because Android freezes an app soon after it leaves the screen, which would stop the download
 * the moment the student goes to look at it. The notification it needs anyway is the progress bar.
 */
class UpdateDownloadService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val job = CurrentDownload.job.get()
    if (intent?.action == ACTION_CANCEL) {
      if (job == null) stopSelf(startId) else job.cancelled = true
      return START_NOT_STICKY
    }
    createChannel()
    // Android requires this soon after the start, whatever happens next.
    goForeground(notification(job?.title.orEmpty(), 0, 0))
    if (job == null) {
      finish(startId)
    } else {
      thread(name = "app-update") { run(job, startId) }
    }
    return START_NOT_STICKY
  }

  private fun run(job: DownloadJob, startId: Int) {
    var failure: Exception? = null
    try {
      fetch(job)
    } catch (error: Exception) {
      failure = error
    }
    finish(startId)
    if (failure == null) job.finished.complete(Unit) else job.finished.completeExceptionally(failure)
  }

  private fun fetch(job: DownloadJob) {
    val part = File("${job.target.path}.part")
    part.parentFile?.mkdirs()
    val connection = URL(job.url).openConnection() as HttpURLConnection
    connection.connectTimeout = CONNECT_TIMEOUT_MS
    connection.readTimeout = READ_TIMEOUT_MS
    job.headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
    try {
      val status = connection.responseCode
      if (status !in 200..299) throw IOException("HTTP $status")
      val total = connection.contentLengthLong
      var done = 0L
      var shownPercent = -1
      var shownAt = 0L
      connection.inputStream.use { input ->
        part.outputStream().use { output ->
          val buffer = ByteArray(BUFFER_BYTES)
          while (true) {
            if (job.cancelled) throw DownloadCancelled()
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            done += read
            val percent = if (total > 0) (done * 100 / total).toInt() else (done / (1024 * 1024)).toInt()
            val now = SystemClock.elapsedRealtime()
            if (percent != shownPercent && now - shownAt >= REPORT_EVERY_MS) {
              shownPercent = percent
              shownAt = now
              manager().notify(NOTIFICATION, notification(job.title, done, total))
              job.onProgress(done, total)
            }
          }
        }
      }
      if (total > 0 && done != total) throw IOException("The download stopped at $done of $total bytes")
      job.onProgress(done, total)
      job.target.delete()
      if (!part.renameTo(job.target)) throw IOException("Could not move the download into place")
    } finally {
      connection.disconnect()
      part.delete()
    }
  }

  private fun finish(startId: Int) {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(startId)
  }

  private fun goForeground(notification: Notification) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION, notification)
      }
    } catch (refused: RuntimeException) {
      // The download still works while the app stays open, so this is no reason to fail the update.
    }
  }

  private fun manager() = getSystemService(NotificationManager::class.java)

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    // Among the notifications people look at, not folded away under "Silent", but without a sound for every update.
    val channel = NotificationChannel(CHANNEL, "Uygulama güncellemesi", NotificationManager.IMPORTANCE_DEFAULT)
    channel.setSound(null, null)
    channel.enableVibration(false)
    channel.setShowBadge(false)
    manager().createNotificationChannel(channel)
  }

  private fun notification(title: String, done: Long, total: Long): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    builder
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .addAction(cancelAction())
    packageManager.getLaunchIntentForPackage(packageName)?.let { open ->
      builder.setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
    }
    if (total > 0) {
      val percent = (done * 100 / total).toInt()
      // In the title, because a folded notification shows the title and the bar but not the text.
      builder
        .setContentTitle("$title · %$percent")
        .setContentText("${megabytes(done)} / ${megabytes(total)} MB")
        .setProgress(100, percent, false)
    } else {
      builder
        .setContentTitle(title)
        .setContentText(if (done > 0) "${megabytes(done)} MB" else "Başlıyor…")
        .setProgress(0, 0, true)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    return builder.build()
  }

  private fun cancelAction(): Notification.Action {
    val cancel = Intent(this, UpdateDownloadService::class.java).setAction(ACTION_CANCEL)
    val pending = PendingIntent.getService(this, 1, cancel, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val icon = Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel)
    return Notification.Action.Builder(icon, "İptal", pending).build()
  }

  private fun megabytes(bytes: Long): String = (bytes / (1024 * 1024)).toString()
}
