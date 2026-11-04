using System.Windows;
using System.Windows.Controls;

namespace AccountSwitcher;

public sealed class RenameWindow : Window
{
    private readonly TextBox _box;

    public string Value => _box.Text;

    public RenameWindow(string current)
    {
        Title = "Rename account";
        Width = 360;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ShowInTaskbar = false;

        _box = new TextBox { Text = current, Margin = new Thickness(0, 6, 0, 14) };
        var save = new Button { Content = "Save", IsDefault = true, MinWidth = 80 };
        if (TryFindResource("AccentButtonStyle") is Style accent) save.Style = accent;
        save.Click += (_, _) => DialogResult = true;
        var cancel = new Button { Content = "Cancel", IsCancel = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        buttons.Children.Add(save);
        buttons.Children.Add(cancel);

        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(new TextBlock { Text = "A name you'll recognise. Leave it empty to go back to the email." , TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(_box);
        panel.Children.Add(buttons);
        Content = panel;

        Loaded += (_, _) =>
        {
            _box.Focus();
            _box.SelectAll();
        };
    }
}
