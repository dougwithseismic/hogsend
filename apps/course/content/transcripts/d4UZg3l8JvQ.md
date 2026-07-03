React email 4.0 just dropped, and there's a bunch of new features. Let's look at them now. I wanna show you a couple of things. Let's start with the resizable sections. So I've got two defaults now. I can go between desktop, I can also pick mobile. However, I can also just size these however I want, either by using the inputs here, or I can drag them and drop them to fit exactly what I need.

So that's the first thing to look out for. Secondly, and this is really cool, you actually have a little bar down below that shows you linting and compatibility and even spam options as well. So you can actually check to make sure that your email will actually land in inboxes based on these metrics.

So all you have to do is click any of these down below here and it will expand it out for you. So you can check the different things in your email. Now this one down here, you can see it actually is going to rate your email as spam checkers see it. And it's using something called Spam Assassin, which is the number one open source tool for checking spam on the internet.

Now let's go ahead and look at what it's saying. It says that higher scores are better. And here I have a 3.9, so we can do some stuff to improve this. So you'll notice that it says that the spam has generic salutation like dear winner. It also talks about free fraud and lots of money.

So somewhere in here, I've got some problems. I can actually scroll down. You'll notice I've got this whole section down here. That's what it's catching for me. And it's using spam assassin to identify those keywords or other things that might be caught by spam filter. So let's go ahead and change this if we can, and I'll move this over.

And now let's go ahead and delete all this section. So right here, I've got the react email code open. And when I save, it should get rid of that and I can rerun the spam checker. And when I do that, it will actually reach back out to spam assassin, double check and now it's 10 out of 10.

Now you've also got a couple of other things here as well. Let's go next to the linter. Now with the linter here, it's telling us there's two items, one for accessibility and one is just the image size. So as this image is downloaded to email clients, it could take a while and slow down emails for people.

And notice over here, not only does it tell me what the problem is, it actually also links directly to the line in the email. So I can click in here and see what both of the problems are here. In this case, I'm using a very large image. And again, up top here, I don't have an alt tag, and I can see that directly here.

So I'll move back to the preview mode, and then let's go ahead and change both of those items. So as I scroll up, I can check, again, the line numbers if I want to. Over here, you can see I'm using this one. I actually have a smaller version that isn't quite as big.

And if I come up top here, you'll notice I need an alt. And Luma Industries, that should work. Now, if I rerun the linter, it should check for both of these and show me that we're up to date. Okay, lastly, let's look at the compatibility. You'll see here it's calling out several different properties, a height property, an object fit, and an RGBA.

If you're familiar with writing emails from scratch, you'll know you cannot use modern HTML and CSS. Here, this compatibility checker uses can I email, which is like can I use, but for emails, to check against both HTML and CSS things that you need to make sure you haven't included. Some of these are more informative, just so you know, and others of them you definitely need to change.

So you can see here, again, I've got links to all these line 50, line 50 and line 113. So I can jump over this way and let's go ahead and change that. So right over here, you'll notice I'm using this object cover. That's not something you can use that will actually work in most clients.

So I can get rid of this altogether. Now it's also mentioning here, I cannot use the height property. So you might think, well, I know what I could do. I could use the like min height full. If we were to do that, let's get rid of this right here. And I rerun the compatibility checker.

You'll notice that this is not supported. This one isn't supported in Outlook, and the other one isn't supported in Yahoo. So in this case, it may be best to actually have a little bit of both. So I could have height full like this. And that way, those in Outlook will be supported with the height property, and those in Yahoo will be supported with the mid-height property.

Now, lastly here, this RGBA, it's on line 114, and I may just want to change this to 1111, and that should work. Now, once again, I can rerun this compatibility checker. I now know I have those two items, but I've done so intelligently to where I know that one of them will render properly for Outlook and the other for Yahoo.

So Linter's good, compatibility checker is good with a little bit of knowledge, and now my spam filter works as well. So React Email 4 gives you a ton right out of the box. And again, this is all open source and you can use it to write your own emails. Let us know what else you would like to know about React Email and if this tutorial was helpful.

Thanks so much for watching. We'll catch you in the next one. Happy sending.
