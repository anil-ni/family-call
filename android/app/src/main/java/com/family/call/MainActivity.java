package com.family.call;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.media.RingtoneManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final int PERMISSION_REQUEST_CODE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createNotificationChannels();
        requestNeededPermissions();

        // Let the page use the camera and microphone without a second prompt;
        // Android has already asked for these at the app level.
        this.bridge.getWebView().setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }

    /** Incoming calls ring loudly; messages get an ordinary notification. */
    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel calls = new NotificationChannel(
            "calls", "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Someone in the family is calling you");
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 400, 200, 400, 200, 400 });
        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (ringtone != null) {
            calls.setSound(ringtone, new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build());
        }
        manager.createNotificationChannel(calls);

        NotificationChannel messages = new NotificationChannel(
            "messages", "Messages", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("New messages from your family");
        messages.enableVibration(true);
        manager.createNotificationChannel(messages);
    }

    private void requestNeededPermissions() {
        List<String> needed = new ArrayList<>();
        addIfMissing(needed, Manifest.permission.CAMERA);
        addIfMissing(needed, Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            addIfMissing(needed, Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(
                this, needed.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }
    }

    private void addIfMissing(List<String> list, String permission) {
        if (ContextCompat.checkSelfPermission(this, permission)
                != PackageManager.PERMISSION_GRANTED) {
            list.add(permission);
        }
    }
}
